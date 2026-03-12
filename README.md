# ai-agent-memory-supabase

Production-ready AI memory system for Supabase. Give your AI agents persistent, searchable long-term memory in 5 minutes.

**Built with**: Supabase + pgvector + PostgreSQL full-text search

## Why This Exists

Most AI apps forget everything between sessions. Vector search alone isn't enough — it misses exact keyword matches. And naive storage creates duplicates everywhere.

This library solves all of that:

- **Hybrid search** — 60% vector similarity + 40% keyword matching via [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
- **Auto-extraction** — LLM extracts facts, preferences, patterns from conversations
- **Deduplication** — Exact + fuzzy (Jaccard > 0.85) prevents duplicate memories
- **Temporal invalidation** — Old memories get superseded, not deleted (audit trail)
- **Entity linking** — Memories connected to people, companies, projects
- **Sensitive data filtering** — API keys, credit cards, SSNs auto-stripped
- **Tiered importance** — HOT/WARM/COLD with access tracking

Extracted from [Kontor](https://getkontor.com), where it handles memory for an AI agent serving solopreneurs with 500+ integrations.

## Quick Start

### 1. Run the migration

```bash
# Copy to your Supabase project
cp node_modules/ai-agent-memory-supabase/supabase/migrations/001_memory_system.sql \
   supabase/migrations/

# Push to your database
npx supabase db push
```

> Make sure pgvector is enabled: Supabase Dashboard → Database → Extensions → Enable "vector"

### 2. Install

```bash
npm install ai-agent-memory-supabase @supabase/supabase-js
```

### 3. Configure

```typescript
import { createClient } from '@supabase/supabase-js';
import {
  createOpenAIEmbeddings,
  createAnthropicExtractor,
  type MemoryConfig,
} from 'ai-agent-memory-supabase';

const config: MemoryConfig = {
  supabase: createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  ),
  embeddings: createOpenAIEmbeddings(process.env.OPENAI_API_KEY!),
  extractor: createAnthropicExtractor(process.env.ANTHROPIC_API_KEY!),
};
```

### 4. Use

```typescript
import {
  retrieveMemories,
  processConversation,
  formatMemoriesForPrompt,
} from 'ai-agent-memory-supabase';

// ── Store memories from a conversation ──────────────
const result = await processConversation(
  config,
  userId,
  'User: I work at Acme Corp as a PM. We use Linear for tracking.\nAssistant: Got it!'
);
// → { stored: 2, duplicatesSkipped: 0, superseded: 0, entitiesLinked: 2 }

// ── Retrieve relevant memories ──────────────────────
const { memories } = await retrieveMemories(config, {
  query: 'What project management tools does the user prefer?',
  userId,
  limit: 5,
});

// ── Inject into your LLM prompt ─────────────────────
const memoryContext = formatMemoriesForPrompt(memories);
// Returns structured markdown:
// <memory>
// ## Known Facts
// - Works at Acme Corp as a PM
// - Uses Linear for project tracking
// </memory>
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Your AI Application                       │
├─────────────────────────────────────────────────────────────┤
│                     supabase-memory                          │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │Extraction│  │ Retrieval│  │  Storage  │  │ Formatting │  │
│  │          │  │          │  │           │  │            │  │
│  │ LLM call │  │  Hybrid  │  │  Dedup +  │  │  Markdown  │  │
│  │ + filter │  │  search  │  │  entities │  │  for LLM   │  │
│  └────┬─────┘  └────┬─────┘  └─────┬─────┘  └────────────┘  │
│       │             │              │                          │
├───────┴─────────────┴──────────────┴─────────────────────────┤
│                      Supabase                                │
│                                                              │
│  ┌──────────────┐  ┌────────────────┐  ┌──────────────────┐ │
│  │   memories    │  │memory_entities │  │memory_entity_links│ │
│  │              │  │                │  │                  │ │
│  │ content      │  │ name           │  │ memory_id        │ │
│  │ embedding[]  │  │ entity_type    │  │ entity_id        │ │
│  │ content_tsv  │  │ normalized     │  │                  │ │
│  │ importance   │  │                │  │                  │ │
│  │ tier         │  │                │  │                  │ │
│  │ expires_at   │  │                │  │                  │ │
│  │ superseded_by│  │                │  │                  │ │
│  └──────────────┘  └────────────────┘  └──────────────────┘ │
│                                                              │
│  SQL Functions:                                              │
│  • memory_hybrid_search()  — RRF fusion (vector + keyword)  │
│  • get_memories_by_entity() — Entity-based lookup            │
│  • increment_memory_access() — LRU tracking                  │
└──────────────────────────────────────────────────────────────┘
```

## Hybrid Search: How It Works

Pure vector search misses exact keyword matches. Pure keyword search misses semantic similarity. We combine both using **Reciprocal Rank Fusion (RRF)**:

```sql
combined_score =
  0.6 * (1 / (60 + vector_rank)) +     -- semantic similarity
  0.4 * (1 / (60 + keyword_rank))      -- exact keyword match
  * importance                           -- weighted by importance
```

This runs entirely in PostgreSQL via a single RPC call — no external search service needed.

## Memory Types

| Type | Description | Example |
|------|-------------|---------|
| `fact` | Concrete information | "Works at Acme Corp as PM" |
| `preference` | How user likes things | "Prefers bullet-point summaries" |
| `pattern` | Recurring behaviors | "Sends weekly reports on Fridays" |
| `learning` | Corrections/feedback | "Don't use formal greetings" |
| `context` | Situational context | "Currently fundraising Series A" |

## Temporal Invalidation

When a memory contradicts an older one, the old memory isn't deleted — it's superseded:

```
Old: "Works at Acme Corp" → expires_at: now, superseded_by: <new_id>
New: "Left Acme, now at Startup Inc"
```

This preserves the full history for auditing while keeping search results current.

## Entity Linking

Memories are automatically linked to named entities:

```typescript
// Extracted memory: "John Smith at Acme Corp prefers Slack"
// → Entities: [
//     { name: "John Smith", type: "person" },
//     { name: "Acme Corp", type: "company" },
//     { name: "Slack", type: "tool" }
//   ]

// Later: "What do we know about Acme Corp?"
const { memories } = await retrieveByEntity(config, {
  userId,
  entityName: 'Acme Corp',
  entityType: 'company',
});
```

## Bring Your Own LLM

Both the embedding provider and the extraction LLM are pluggable:

```typescript
import type { EmbeddingProvider, ExtractionLLM } from 'ai-agent-memory-supabase';

// Custom embedding provider (must return 1536-dim vectors)
const myEmbeddings: EmbeddingProvider = {
  async generate(text) {
    const vec = await myModel.embed(text);
    return { embedding: vec, model: 'my-model', tokens: 0 };
  },
  async generateBatch(texts) {
    return Promise.all(texts.map((t) => this.generate(t)));
  },
};

// Custom extraction LLM
const myExtractor: ExtractionLLM = {
  async extract(systemPrompt, userMessage) {
    return await myLLM.chat(systemPrompt, userMessage);
  },
};
```

Built-in adapters:
- `createOpenAIEmbeddings(apiKey)` — text-embedding-3-small (1536 dims)
- `createAnthropicExtractor(apiKey)` — Claude Haiku (recommended, ~$0.001/extraction)
- `createOpenAIExtractor(apiKey)` — GPT-4o-mini

## API Reference

### `retrieveMemories(config, options)`

Hybrid search for relevant memories.

```typescript
const { memories } = await retrieveMemories(config, {
  query: 'project management preferences',
  userId: 'user-uuid',
  limit: 10,              // default: 10
  minImportance: 0.3,     // default: 0.3
  types: ['preference'],  // optional filter
});
```

### `retrieveByEntity(config, options)`

Find all memories linked to a named entity.

```typescript
const { memories } = await retrieveByEntity(config, {
  userId: 'user-uuid',
  entityName: 'Acme Corp',
  entityType: 'company',  // optional
  limit: 20,
});
```

### `processConversation(config, userId, conversation)`

Extract and store memories from a conversation in one step.

```typescript
const result = await processConversation(config, userId, conversationText);
// result.stored — new memories saved
// result.duplicatesSkipped — deduped
// result.superseded — old memories invalidated
// result.entitiesLinked — entity connections created
```

### `storeMemories(config, userId, memories)`

Store pre-extracted memories with dedup + entity linking.

```typescript
await storeMemories(config, userId, [
  {
    type: 'fact',
    content: 'User manages a team of 12 engineers',
    importance: 0.8,
    entities: [{ name: 'Engineering Team', type: 'project' }],
  },
]);
```

### `formatMemoriesForPrompt(memories)`

Format retrieved memories as structured markdown for LLM injection.

### `extractMemories(extractor, conversation, existingMemories?)`

Extract memories from text without storing (useful for previewing).

## Database Schema

The migration creates:

| Table | Purpose |
|-------|---------|
| `memories` | Core storage (content, embedding, importance, tier, expiration) |
| `memory_entities` | Named entities (person, company, project, tool, place) |
| `memory_entity_links` | Many-to-many join (memory ↔ entity) |

SQL functions:

| Function | Purpose |
|----------|---------|
| `memory_hybrid_search()` | Combined vector + keyword search via RRF |
| `search_memories_by_embedding()` | Pure vector similarity search |
| `increment_memory_access()` | Batch update access counts |
| `get_memories_by_entity()` | Entity-based memory lookup |

All tables have RLS enabled with `user_id = auth.uid()` policies + service role bypass.

## Cost Estimate

For a typical AI chat app with ~100 conversations/day:

| Component | Cost |
|-----------|------|
| Embeddings (OpenAI) | ~$0.02/day |
| Extraction (Claude Haiku) | ~$0.10/day |
| Supabase | Free tier works fine |
| **Total** | **~$3.60/mo** |

## License

MIT
