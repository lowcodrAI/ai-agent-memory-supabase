import type {
  DbClient,
  EntitySearchOptions,
  EmbeddingProvider,
  Memory,
  MemoryConfig,
  RetrievalOptions,
  RetrievalResult,
} from './types';

/**
 * Retrieve relevant memories using hybrid search (vector + keyword via RRF).
 */
export async function retrieveMemories(
  config: MemoryConfig,
  options: RetrievalOptions
): Promise<RetrievalResult> {
  const { query, userId, limit = 10, minImportance = 0.3, types } = options;

  try {
    const { embedding } = await config.embeddings.generate(query);

    if (!embedding) {
      return { memories: [], totalFound: 0, searchMethod: 'hybrid' };
    }

    const { data, error } = await config.supabase.rpc('memory_hybrid_search', {
      p_user_id: userId,
      p_query_embedding: embedding,
      p_query_text: query,
      p_match_count: limit,
    });

    if (error) {
      console.error('[supabase-memory] Hybrid search error:', error);
      return { memories: [], totalFound: 0, searchMethod: 'hybrid' };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let memories = (data || []).map((row: any) => ({
      ...row,
      relevance_score: row.combined_score,
    })) as Memory[];

    // Client-side filters
    memories = memories.filter((m) => m.importance >= minImportance);
    if (types && types.length > 0) {
      memories = memories.filter((m) => types.includes(m.type));
    }
    memories = memories.slice(0, limit);

    // Update access counts
    if (memories.length > 0) {
      await config.supabase.rpc('increment_memory_access', {
        memory_ids: memories.map((m) => m.id),
      });
    }

    return { memories, totalFound: memories.length, searchMethod: 'hybrid' };
  } catch (error) {
    console.error('[supabase-memory] Retrieval error:', error);
    return { memories: [], totalFound: 0, searchMethod: 'hybrid' };
  }
}

/**
 * Retrieve memories linked to a specific entity (person, company, project, etc.)
 */
export async function retrieveByEntity(
  config: MemoryConfig,
  options: EntitySearchOptions
): Promise<RetrievalResult> {
  const { userId, entityName, entityType, limit = 20 } = options;

  try {
    const { data, error } = await config.supabase.rpc(
      'get_memories_by_entity',
      {
        p_user_id: userId,
        p_entity_name: entityName,
        p_entity_type: entityType || null,
        p_include_expired: false,
        p_limit: limit,
      }
    );

    if (error) {
      console.error('[supabase-memory] Entity search error:', error);
      return { memories: [], totalFound: 0, searchMethod: 'keyword' };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const memories = (data || []).map((row: any) => ({
      id: row.id,
      user_id: userId,
      type: row.type,
      source: 'agent' as const,
      content: row.content,
      importance: row.importance,
      tier: row.tier,
      access_count: 0,
      last_accessed_at: null,
      metadata: row.metadata,
      created_at: row.created_at,
    })) as Memory[];

    if (memories.length > 0) {
      await config.supabase.rpc('increment_memory_access', {
        memory_ids: memories.map((m) => m.id),
      });
    }

    return { memories, totalFound: memories.length, searchMethod: 'keyword' };
  } catch (error) {
    console.error('[supabase-memory] Entity retrieval error:', error);
    return { memories: [], totalFound: 0, searchMethod: 'keyword' };
  }
}
