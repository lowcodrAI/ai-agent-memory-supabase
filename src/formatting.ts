import type { Memory, MemoryType } from './types';

/**
 * Format memories for injection into an LLM system prompt.
 * Groups memories by type with structured markdown.
 */
export function formatMemoriesForPrompt(memories: Memory[]): string {
  if (memories.length === 0) return '';

  const sections: Record<MemoryType, Memory[]> = {
    fact: [],
    preference: [],
    pattern: [],
    learning: [],
    context: [],
  };

  for (const m of memories) {
    if (sections[m.type]) {
      sections[m.type].push(m);
    }
  }

  const parts: string[] = ['<memory>'];

  if (sections.fact.length > 0) {
    parts.push('## Known Facts');
    for (const m of sections.fact) parts.push(`- ${m.content}`);
  }

  if (sections.preference.length > 0) {
    parts.push('\n## User Preferences');
    for (const m of sections.preference) parts.push(`- ${m.content}`);
  }

  if (sections.pattern.length > 0) {
    parts.push('\n## Observed Patterns');
    for (const m of sections.pattern) parts.push(`- ${m.content}`);
  }

  if (sections.learning.length > 0) {
    parts.push('\n## Previous Learnings');
    for (const m of sections.learning) parts.push(`- ${m.content}`);
  }

  if (sections.context.length > 0) {
    parts.push('\n## Relevant Context');
    for (const m of sections.context) parts.push(`- ${m.content}`);
  }

  parts.push('</memory>');
  return parts.join('\n');
}
