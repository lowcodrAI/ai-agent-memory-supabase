-- ============================================
-- supabase-memory: AI Memory System
-- ============================================
-- Run: npx supabase db push
-- Requires: pgvector extension enabled in Supabase dashboard
--           (Database > Extensions > Enable "vector")

-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS "vector";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================
-- MEMORIES (Core storage with HOT/WARM/COLD tiers)
-- ============================================
CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('fact', 'preference', 'pattern', 'learning', 'context')),
  source TEXT DEFAULT 'agent' CHECK (source IN ('agent', 'user', 'system')),
  content TEXT NOT NULL,
  content_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  embedding VECTOR(1536),
  importance REAL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  decay_rate REAL DEFAULT 0.01,
  tier TEXT DEFAULT 'WARM' CHECK (tier IN ('HOT', 'WARM', 'COLD')),
  access_count INTEGER DEFAULT 0,
  last_accessed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  superseded_by UUID REFERENCES memories(id) ON DELETE SET NULL,
  superseded_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Vector similarity index (cosine distance)
CREATE INDEX IF NOT EXISTS memories_embedding_idx
  ON memories USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Full-text search index
CREATE INDEX IF NOT EXISTS memories_tsv_idx
  ON memories USING GIN (content_tsv);

-- Tier + importance lookup
CREATE INDEX IF NOT EXISTS memories_user_tier_idx
  ON memories(user_id, tier, importance DESC);

-- ============================================
-- MEMORY ENTITIES (Named entity linking)
-- ============================================
CREATE TABLE IF NOT EXISTS memory_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'company', 'project', 'tool', 'place', 'other')),
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS memory_entities_user_norm_type_idx
  ON memory_entities(user_id, normalized_name, entity_type);

-- ============================================
-- MEMORY ENTITY LINKS (Join table)
-- ============================================
CREATE TABLE IF NOT EXISTS memory_entity_links (
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES memory_entities(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, entity_id)
);

CREATE INDEX IF NOT EXISTS memory_entity_links_entity_idx
  ON memory_entity_links(entity_id);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_entity_links ENABLE ROW LEVEL SECURITY;

-- Memories: user isolation
CREATE POLICY "Users can access own memories"
  ON memories FOR ALL USING (user_id = auth.uid());

CREATE POLICY "Service role full access to memories"
  ON memories FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Entities: user isolation
CREATE POLICY "Users can manage own memory entities"
  ON memory_entities FOR ALL USING (user_id = auth.uid());

CREATE POLICY "Service role full access to memory entities"
  ON memory_entities FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Entity links: via memory ownership
CREATE POLICY "Users can manage own entity links"
  ON memory_entity_links FOR ALL
  USING (memory_id IN (SELECT id FROM memories WHERE user_id = auth.uid()));

CREATE POLICY "Service role full access to entity links"
  ON memory_entity_links FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ============================================
-- HYBRID SEARCH (Vector + Keyword via RRF)
-- ============================================
CREATE OR REPLACE FUNCTION memory_hybrid_search(
  p_user_id UUID,
  p_query_embedding VECTOR(1536),
  p_query_text TEXT,
  p_vector_weight REAL DEFAULT 0.6,
  p_keyword_weight REAL DEFAULT 0.4,
  p_match_count INTEGER DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  type TEXT,
  source TEXT,
  tier TEXT,
  importance REAL,
  access_count INTEGER,
  last_accessed_at TIMESTAMPTZ,
  metadata JSONB,
  created_at TIMESTAMPTZ,
  combined_score REAL
) AS $$
WITH vector_results AS (
  SELECT
    m.id,
    m.content,
    m.type,
    m.source,
    m.tier,
    m.importance,
    m.access_count,
    m.last_accessed_at,
    m.metadata,
    m.created_at,
    ROW_NUMBER() OVER (ORDER BY m.embedding <=> p_query_embedding) AS vector_rank
  FROM memories m
  WHERE m.user_id = p_user_id
    AND m.embedding IS NOT NULL
    AND (m.expires_at IS NULL OR m.expires_at > now())
  ORDER BY m.embedding <=> p_query_embedding
  LIMIT p_match_count * 2
),
keyword_results AS (
  SELECT
    m.id,
    m.content,
    m.type,
    m.source,
    m.tier,
    m.importance,
    m.access_count,
    m.last_accessed_at,
    m.metadata,
    m.created_at,
    ROW_NUMBER() OVER (
      ORDER BY ts_rank(m.content_tsv, websearch_to_tsquery('english', p_query_text)) DESC
    ) AS keyword_rank
  FROM memories m
  WHERE m.user_id = p_user_id
    AND m.content_tsv @@ websearch_to_tsquery('english', p_query_text)
    AND (m.expires_at IS NULL OR m.expires_at > now())
  LIMIT p_match_count * 2
),
combined AS (
  SELECT
    COALESCE(v.id, k.id) AS id,
    COALESCE(v.content, k.content) AS content,
    COALESCE(v.type, k.type) AS type,
    COALESCE(v.source, k.source) AS source,
    COALESCE(v.tier, k.tier) AS tier,
    COALESCE(v.importance, k.importance) AS importance,
    COALESCE(v.access_count, k.access_count) AS access_count,
    COALESCE(v.last_accessed_at, k.last_accessed_at) AS last_accessed_at,
    COALESCE(v.metadata, k.metadata) AS metadata,
    COALESCE(v.created_at, k.created_at) AS created_at,
    (
      p_vector_weight * COALESCE(1.0 / (60 + v.vector_rank), 0) +
      p_keyword_weight * COALESCE(1.0 / (60 + k.keyword_rank), 0)
    ) * COALESCE(v.importance, k.importance, 0.5) AS combined_score
  FROM vector_results v
  FULL OUTER JOIN keyword_results k ON v.id = k.id
)
SELECT * FROM combined
ORDER BY combined_score DESC
LIMIT p_match_count;
$$ LANGUAGE SQL STABLE;

-- ============================================
-- VECTOR-ONLY SEARCH
-- ============================================
CREATE OR REPLACE FUNCTION search_memories_by_embedding(
  query_embedding VECTOR(1536),
  match_user_id UUID,
  match_threshold FLOAT DEFAULT 0.7,
  match_count INT DEFAULT 10
)
RETURNS TABLE (
  id UUID,
  user_id UUID,
  type TEXT,
  source TEXT,
  content TEXT,
  importance REAL,
  tier TEXT,
  access_count INTEGER,
  last_accessed_at TIMESTAMPTZ,
  metadata JSONB,
  created_at TIMESTAMPTZ,
  similarity FLOAT
)
LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id, m.user_id, m.type, m.source, m.content,
    m.importance, m.tier, m.access_count, m.last_accessed_at,
    m.metadata, m.created_at,
    1 - (m.embedding <=> query_embedding) AS similarity
  FROM memories m
  WHERE m.user_id = match_user_id
    AND m.embedding IS NOT NULL
    AND (m.expires_at IS NULL OR m.expires_at > now())
    AND 1 - (m.embedding <=> query_embedding) > match_threshold
  ORDER BY m.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================
-- ACCESS COUNT TRACKING
-- ============================================
CREATE OR REPLACE FUNCTION increment_memory_access(memory_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE memories
  SET access_count = access_count + 1,
      last_accessed_at = now()
  WHERE id = ANY(memory_ids);
END;
$$;

-- ============================================
-- ENTITY-BASED MEMORY LOOKUP
-- ============================================
CREATE OR REPLACE FUNCTION get_memories_by_entity(
  p_user_id UUID,
  p_entity_name TEXT,
  p_entity_type TEXT DEFAULT NULL,
  p_include_expired BOOLEAN DEFAULT FALSE,
  p_limit INTEGER DEFAULT 20
)
RETURNS TABLE (
  id UUID,
  content TEXT,
  type TEXT,
  importance REAL,
  tier TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ,
  entity_name TEXT,
  entity_type TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id, m.content, m.type, m.importance, m.tier,
    m.metadata, m.created_at,
    me.name AS entity_name,
    me.entity_type AS entity_type
  FROM memories m
  INNER JOIN memory_entity_links mel ON mel.memory_id = m.id
  INNER JOIN memory_entities me ON me.id = mel.entity_id
  WHERE m.user_id = p_user_id
    AND me.user_id = p_user_id
    AND (
      me.normalized_name ILIKE '%' || LOWER(TRIM(p_entity_name)) || '%'
      OR LOWER(TRIM(p_entity_name)) ILIKE '%' || me.normalized_name || '%'
    )
    AND (p_entity_type IS NULL OR me.entity_type = p_entity_type)
    AND (p_include_expired OR m.expires_at IS NULL OR m.expires_at > now())
  ORDER BY m.importance DESC, m.created_at DESC
  LIMIT p_limit;
END;
$$;
