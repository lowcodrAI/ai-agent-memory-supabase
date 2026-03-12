import type {
  ExtractedMemory,
  ExtractionResult,
  MemoryConfig,
} from './types';

// ── Text Normalization ──────────────────────────────────

function normalizeContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Jaccard similarity between two normalized strings.
 */
function jaccardSimilarity(a: string, b: string): number {
  const wordsA = a.split(' ');
  const wordsB = new Set(b.split(' '));
  const setA = new Set(wordsA);

  let intersection = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) intersection++;
  }

  const union = setA.size + wordsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Store ───────────────────────────────────────────────

/**
 * Store extracted memories with deduplication, embedding, entity linking,
 * and temporal invalidation.
 */
export async function storeMemories(
  config: MemoryConfig,
  userId: string,
  memories: ExtractedMemory[]
): Promise<ExtractionResult> {
  if (memories.length === 0) {
    return {
      extracted: [],
      stored: 0,
      duplicatesSkipped: 0,
      superseded: 0,
      entitiesLinked: 0,
    };
  }

  // ── Deduplication ───────────────────────────────────

  const { data: existing } = await config.supabase
    .from('memories')
    .select('content')
    .eq('user_id', userId);

  const existingNormalized = new Set(
    (existing || []).map((m: { content: string }) => normalizeContent(m.content))
  );

  const newMemories: ExtractedMemory[] = [];
  let duplicatesSkipped = 0;

  for (const memory of memories) {
    const normalized = normalizeContent(memory.content);

    // Exact match
    if (existingNormalized.has(normalized)) {
      duplicatesSkipped++;
      continue;
    }

    // Fuzzy match (Jaccard > 0.85)
    const isDuplicate = Array.from(existingNormalized).some(
      (ex) => jaccardSimilarity(normalized, ex) > 0.85
    );

    if (isDuplicate) {
      duplicatesSkipped++;
      continue;
    }

    newMemories.push(memory);
    existingNormalized.add(normalized);
  }

  if (newMemories.length === 0) {
    return {
      extracted: memories,
      stored: 0,
      duplicatesSkipped,
      superseded: 0,
      entitiesLinked: 0,
    };
  }

  // ── Generate Embeddings ─────────────────────────────

  const embeddingResults = await config.embeddings.generateBatch(
    newMemories.map((m) => m.content)
  );

  // ── Insert Memories ─────────────────────────────────

  const { data: insertedRows, error } = await config.supabase
    .from('memories')
    .insert(
      newMemories.map((m, i) => ({
        user_id: userId,
        type: m.type,
        source: 'agent',
        content: m.content,
        importance: m.importance,
        tier: m.importance >= 0.7 ? 'HOT' : m.importance >= 0.4 ? 'WARM' : 'COLD',
        embedding: embeddingResults[i]?.embedding ?? null,
        metadata: m.metadata || {},
      }))
    )
    .select('id, content');

  if (error) {
    console.error('[supabase-memory] Insert error:', error);
    return {
      extracted: memories,
      stored: 0,
      duplicatesSkipped,
      superseded: 0,
      entitiesLinked: 0,
    };
  }

  const inserted = insertedRows || [];
  const insertedByContent = new Map(
    inserted.map((r: { id: string; content: string }) => [
      normalizeContent(r.content),
      r,
    ])
  );

  // ── Temporal Invalidation ───────────────────────────

  let supersededCount = 0;
  const existingMemoryContents = existing || [];

  for (const memory of newMemories) {
    if (!memory.supersedes) continue;

    const normalizedSupersedes = normalizeContent(memory.supersedes);
    const insertedRow = insertedByContent.get(
      normalizeContent(memory.content)
    );
    if (!insertedRow) continue;

    const matchingOld = existingMemoryContents.find(
      (old: { content: string }) =>
        jaccardSimilarity(
          normalizeContent(old.content),
          normalizedSupersedes
        ) > 0.7
    );

    if (matchingOld) {
      const { data: oldRow } = await config.supabase
        .from('memories')
        .select('id')
        .eq('user_id', userId)
        .eq('content', matchingOld.content)
        .is('expires_at', null)
        .limit(1)
        .single();

      if (oldRow) {
        await config.supabase
          .from('memories')
          .update({
            expires_at: new Date().toISOString(),
            superseded_by: insertedRow.id,
            superseded_at: new Date().toISOString(),
          })
          .eq('id', oldRow.id);

        supersededCount++;
      }
    }
  }

  // ── Entity Linking ──────────────────────────────────

  let entitiesLinkedCount = 0;

  for (const memory of newMemories) {
    if (!memory.entities || memory.entities.length === 0) continue;

    const insertedRow = insertedByContent.get(
      normalizeContent(memory.content)
    );
    if (!insertedRow) continue;

    for (const entity of memory.entities) {
      const normalizedName = entity.name.toLowerCase().trim();

      const { data: entityRow } = await config.supabase
        .from('memory_entities')
        .upsert(
          {
            user_id: userId,
            name: entity.name,
            normalized_name: normalizedName,
            entity_type: entity.type,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,normalized_name,entity_type' }
        )
        .select('id')
        .single();

      if (!entityRow) continue;

      const { error: linkError } = await config.supabase
        .from('memory_entity_links')
        .upsert(
          { memory_id: insertedRow.id, entity_id: entityRow.id },
          { onConflict: 'memory_id,entity_id', ignoreDuplicates: true }
        );

      if (!linkError) entitiesLinkedCount++;
    }
  }

  return {
    extracted: memories,
    stored: newMemories.length,
    duplicatesSkipped,
    superseded: supersededCount,
    entitiesLinked: entitiesLinkedCount,
  };
}
