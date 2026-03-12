import type { EmbeddingProvider, EmbeddingResult } from './types';

/**
 * Create an OpenAI embedding provider.
 * Uses text-embedding-3-small (1536 dimensions) — matches the DB schema.
 */
export function createOpenAIEmbeddings(apiKey: string): EmbeddingProvider {
  return {
    async generate(text: string): Promise<EmbeddingResult> {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          input: text,
          model: 'text-embedding-3-small',
        }),
      });

      if (!response.ok) {
        console.error('[supabase-memory] OpenAI embedding error:', response.status);
        return { embedding: null, model: null, tokens: 0 };
      }

      const data = await response.json();
      return {
        embedding: data.data[0].embedding,
        model: 'text-embedding-3-small',
        tokens: data.usage?.total_tokens || 0,
      };
    },

    async generateBatch(texts: string[]): Promise<EmbeddingResult[]> {
      if (texts.length === 0) return [];

      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          input: texts,
          model: 'text-embedding-3-small',
        }),
      });

      if (!response.ok) {
        console.error('[supabase-memory] OpenAI batch error:', response.status);
        // Fallback to individual calls
        return Promise.all(texts.map((t) => this.generate(t)));
      }

      const data = await response.json();
      const sorted = data.data.sort(
        (a: { index: number }, b: { index: number }) => a.index - b.index
      );
      const tokensPerItem = Math.floor((data.usage?.total_tokens || 0) / texts.length);

      return sorted.map((d: { embedding: number[] }) => ({
        embedding: d.embedding,
        model: 'text-embedding-3-small',
        tokens: tokensPerItem,
      }));
    },
  };
}
