import type {
  DbClient,
  ExtractedMemory,
  ExtractionLLM,
  ExtractionResult,
  MemoryConfig,
} from './types';
import { storeMemories } from './store';

// ── Extraction Prompt ───────────────────────────────────

const EXTRACTION_PROMPT = `You are analyzing a conversation to extract important information worth remembering about the user.

Extract ONLY information that would be valuable for future interactions. Focus on:

1. **Facts**: Concrete information (company name, role, team size, industry, key dates, projects)
2. **Preferences**: How the user likes things done (communication style, formats, tools, scheduling)
3. **Patterns**: Recurring behaviors or needs (weekly reports, regular meetings, common requests)
4. **Learnings**: Corrections or feedback the user provided (mistakes to avoid, preferred approaches)

Do NOT extract:
- Temporary context (current task details unless recurring)
- Obvious information that doesn't add value
- SENSITIVE DATA: API keys, passwords, tokens, secrets, credit card numbers, SSN, private keys

For each memory, assign an importance score (0.0-1.0):
- 1.0: Critical (user explicitly stated this is important)
- 0.8-0.9: High (key facts affecting most interactions)
- 0.5-0.7: Medium (useful but not critical)
- 0.3-0.4: Low (nice to know)

Respond with valid JSON:
{
  "memories": [
    {
      "type": "fact" | "preference" | "pattern" | "learning",
      "content": "Clear, standalone statement",
      "importance": 0.0-1.0,
      "entities": [{"name": "Google", "type": "company"}],
      "supersedes": "exact content of old memory this replaces, or null"
    }
  ]
}

Entity types: person, company, project, tool, place, other.
"supersedes": Only for genuine contradictions (changed company, new preference), NOT related-but-different info.

If nothing worth extracting: {"memories": []}`;

// ── Sensitive Data Filter ───────────────────────────────

const SENSITIVE_PATTERNS = [
  /sk[-_]?[a-zA-Z0-9]{20,}/i,
  /pk[-_]?[a-zA-Z0-9]{20,}/i,
  /api[-_]?key[-_:]?\s*[a-zA-Z0-9]{16,}/i,
  /bearer\s+[a-zA-Z0-9._-]{20,}/i,
  /token[-_:]?\s*[a-zA-Z0-9]{20,}/i,
  /secret[-_:]?\s*[a-zA-Z0-9]{16,}/i,
  /password[-_:]?\s*\S{8,}/i,
  /\b4[0-9]{12}(?:[0-9]{3})?\b/,          // Visa
  /\b5[1-5][0-9]{14}\b/,                   // Mastercard
  /\b3[47][0-9]{13}\b/,                    // Amex
  /\b[0-9]{4}[-\s]?[0-9]{4}[-\s]?[0-9]{4}[-\s]?[0-9]{4}\b/,
  /\b[0-9]{3}[-\s]?[0-9]{2}[-\s]?[0-9]{4}\b/, // SSN
  /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i,
  /-----BEGIN\s+EC\s+PRIVATE\s+KEY-----/i,
  /AKIA[0-9A-Z]{16}/,                      // AWS
  /ghp_[a-zA-Z0-9]{36}/,                   // GitHub PAT
  /gho_[a-zA-Z0-9]{36}/,                   // GitHub OAuth
  /client[-_]?secret[-_:]?\s*[a-zA-Z0-9]{16,}/i,
];

function containsSensitiveData(content: string): boolean {
  return SENSITIVE_PATTERNS.some((p) => p.test(content));
}

// ── Extract ─────────────────────────────────────────────

const VALID_TYPES = ['fact', 'preference', 'pattern', 'learning', 'context'] as const;
const VALID_ENTITY_TYPES = ['person', 'company', 'project', 'tool', 'place', 'other'];

/**
 * Extract memories from a conversation using an LLM.
 */
export async function extractMemories(
  extractor: ExtractionLLM,
  conversation: string,
  existingMemories?: string[]
): Promise<ExtractedMemory[]> {
  let systemPrompt = EXTRACTION_PROMPT;
  if (existingMemories && existingMemories.length > 0) {
    systemPrompt += `\n\nExisting memories (DO NOT extract duplicates):\n${existingMemories.map((m) => `- ${m}`).join('\n')}`;
  }

  const responseText = await extractor.extract(
    systemPrompt,
    `Analyze this conversation and extract important memories:\n\n${conversation}`
  );

  try {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return [];

    const result = JSON.parse(jsonMatch[0]);
    const memories: ExtractedMemory[] = (result.memories || [])
      .map(
        (m: {
          type: string;
          content: string;
          importance: number;
          entities?: { name: string; type: string }[];
          supersedes?: string;
        }) => ({
          type: VALID_TYPES.includes(m.type as (typeof VALID_TYPES)[number])
            ? m.type
            : 'fact',
          content: m.content,
          importance: Math.max(0, Math.min(1, m.importance)),
          entities: Array.isArray(m.entities)
            ? m.entities.filter(
                (e) => e.name && VALID_ENTITY_TYPES.includes(e.type)
              )
            : undefined,
          supersedes:
            typeof m.supersedes === 'string' && m.supersedes.length > 0
              ? m.supersedes
              : undefined,
        })
      )
      .filter((m: ExtractedMemory) => !containsSensitiveData(m.content));

    return memories;
  } catch {
    console.error('[supabase-memory] Failed to parse extraction response');
    return [];
  }
}

/**
 * Extract and store memories from a conversation in one step.
 */
export async function processConversation(
  config: MemoryConfig,
  userId: string,
  conversation: string
): Promise<ExtractionResult> {
  if (!config.extractor) {
    throw new Error(
      'No extractor configured. Pass an ExtractionLLM to MemoryConfig.'
    );
  }

  // Get existing memories to avoid duplicates
  const { data: existing } = await config.supabase
    .from('memories')
    .select('content')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);

  const existingContents = (existing || []).map(
    (m: { content: string }) => m.content
  );

  const extracted = await extractMemories(
    config.extractor,
    conversation,
    existingContents
  );

  return storeMemories(config, userId, extracted);
}

// ── Anthropic Adapter ───────────────────────────────────

/**
 * Create an Anthropic-based extractor (Claude Haiku).
 * This is the recommended extractor — cheap and fast.
 */
export function createAnthropicExtractor(
  apiKey: string,
  model: string = 'claude-haiku-4-5-20251001'
): ExtractionLLM {
  return {
    async extract(systemPrompt: string, userMessage: string): Promise<string> {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        }),
      });

      if (!response.ok) {
        throw new Error(`Anthropic API error: ${response.status}`);
      }

      const data = await response.json();
      return data.content?.[0]?.text || '';
    },
  };
}

/**
 * Create an OpenAI-based extractor (GPT-4o-mini).
 */
export function createOpenAIExtractor(
  apiKey: string,
  model: string = 'gpt-4o-mini'
): ExtractionLLM {
  return {
    async extract(systemPrompt: string, userMessage: string): Promise<string> {
      const response = await fetch(
        'https://api.openai.com/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            max_tokens: 1024,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userMessage },
            ],
          }),
        }
      );

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${response.status}`);
      }

      const data = await response.json();
      return data.choices?.[0]?.message?.content || '';
    },
  };
}
