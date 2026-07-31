import type Anthropic from '@anthropic-ai/sdk';
import type { AIProvider, AiReplyContext, AiReplyResult } from './types.js';

export interface AnthropicProviderOptions {
  /**
   * Pre-constructed `Anthropic` client. Passing the client (rather than just
   * an API key) lets callers configure baseURL, fetch, timeouts, etc.
   */
  client: Anthropic;
  /**
   * Model id. Defaults to Claude Haiku 4.5 — the cheapest current model that
   * still produces high-quality support replies. Override with a Sonnet model
   * for higher-stakes brands.
   */
  model?: string;
  maxTokens?: number;
}

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_MAX_TOKENS = 600;

/**
 * Anthropic Claude AI provider.
 *
 * Uses prompt caching on the system prompt — it's identical across every reply
 * for a given brand, so caching it pays for itself after the first hit. The
 * conversation history is short and shifts each turn, so it is not cached.
 */
export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: AnthropicProviderOptions) {
    this.client = opts.client;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async reply(ctx: AiReplyContext): Promise<AiReplyResult> {
    const localeNote = ctx.locale
      ? `\n\nThe user's preferred language is "${ctx.locale}". Respond in that language.`
      : '';

    const response = await this.client.messages.create(
      {
        model: this.model,
        max_tokens: this.maxTokens,
        system: [
          {
            type: 'text',
            text: ctx.systemPrompt + localeNote,
            cache_control: { type: 'ephemeral' },
          },
        ],
        messages: ctx.history.map((m) => ({
          role: m.senderType === 'user' ? ('user' as const) : ('assistant' as const),
          content: m.body,
        })),
      },
      { signal: ctx.signal }
    );

    const text = response.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    return {
      body: text || "I'm sorry — I couldn't generate a response. A team member will follow up shortly.",
      meta: {
        model: response.model,
        stopReason: response.stop_reason,
        usage: response.usage,
      },
    };
  }
}
