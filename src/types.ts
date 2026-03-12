import type { SupabaseClient } from '@supabase/supabase-js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbClient = SupabaseClient<any>;

// ── Memory ──────────────────────────────────────────────

export type MemoryType = 'fact' | 'preference' | 'pattern' | 'learning' | 'context';
export type MemorySource = 'agent' | 'user' | 'system';
export type MemoryTier = 'HOT' | 'WARM' | 'COLD';

export interface Memory {
  id: string;
  user_id: string;
  type: MemoryType;
  source: MemorySource;
  content: string;
  importance: number;
  tier: MemoryTier;
  access_count: number;
  last_accessed_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  relevance_score?: number;
}

export interface ExtractedMemory {
  type: MemoryType;
  content: string;
  importance: number;
  metadata?: Record<string, unknown>;
  entities?: { name: string; type: string }[];
  supersedes?: string;
}

// ── Search ──────────────────────────────────────────────

export interface RetrievalOptions {
  query: string;
  userId: string;
  limit?: number;
  minImportance?: number;
  types?: MemoryType[];
}

export interface RetrievalResult {
  memories: Memory[];
  totalFound: number;
  searchMethod: 'hybrid' | 'vector' | 'keyword';
}

export interface EntitySearchOptions {
  userId: string;
  entityName: string;
  entityType?: string;
  limit?: number;
}

// ── Extraction ──────────────────────────────────────────

export interface ExtractionResult {
  extracted: ExtractedMemory[];
  stored: number;
  duplicatesSkipped: number;
  superseded: number;
  entitiesLinked: number;
}

// ── Embedding ───────────────────────────────────────────

export interface EmbeddingResult {
  embedding: number[] | null;
  model: string | null;
  tokens: number;
}

/**
 * Pluggable embedding provider.
 * Implement this interface to use any embedding model.
 */
export interface EmbeddingProvider {
  generate(text: string): Promise<EmbeddingResult>;
  generateBatch(texts: string[]): Promise<EmbeddingResult[]>;
}

/**
 * Pluggable LLM provider for memory extraction.
 * Implement this interface to use any LLM (Claude, GPT, Gemini, etc.)
 */
export interface ExtractionLLM {
  extract(systemPrompt: string, userMessage: string): Promise<string>;
}

// ── Config ──────────────────────────────────────────────

export interface MemoryConfig {
  /** Supabase client (service role recommended for server-side) */
  supabase: DbClient;
  /** Embedding provider (use createOpenAIEmbeddings() or bring your own) */
  embeddings: EmbeddingProvider;
  /** LLM for memory extraction (use createAnthropicExtractor() or bring your own) */
  extractor?: ExtractionLLM;
}
