import type Anthropic from '@anthropic-ai/sdk';

import type { AiProvider, AiReplyContext, AiReplyResult, Message } from '../../types.js';

export interface AnthropicProviderOptions {
  /**
   * Pre-constructed `Anthropic` client. Passing the client (rather than just
   * an API key) lets callers configure baseURL, fetch, timeouts, etc.
   */
  client: Anthropic;
  /**
   * Model id. Defaults to Claude Haiku 4.5 — the cheapest current model that
   * still produces high-quality support replies. Override with a Sonnet or Opus
   * model for higher-stakes brands.
   */
  model?: string;
  maxTokens?: number;
}

const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_MAX_TOKENS = 600;

const FALLBACK_SYSTEM_PROMPT =
  'You are a helpful customer support assistant embedded in a live chat widget. ' +
  'Answer concisely. If you cannot help, say so plainly and tell the visitor a ' +
  'human will follow up.';

const HANDOFF_BODY =
  "I'm sorry — I couldn't generate a response. A team member will follow up shortly.";

/**
 * Anthropic Claude AI provider.
 *
 * Uses prompt caching on the system prompt — it's identical across every reply
 * for a given brand, so caching it pays for itself after the first hit (note
 * that short brand prompts fall under the model's minimum cacheable prefix and
 * simply won't cache; the marker is harmless there). The conversation history is
 * short and shifts each turn, so it is not cached.
 */
export class AnthropicProvider implements AiProvider {
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
    const messages = toAnthropicMessages(ctx.messages);
    // Nothing a visitor actually said — there is no question to answer, so hand
    // straight to a human rather than making the model invent a topic.
    if (messages.length === 0) return { body: HANDOFF_BODY, handoff: true };

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: [
        {
          type: 'text',
          text: ctx.systemPrompt ?? FALLBACK_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages,
    });

    const text = response.content
      .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();

    if (!text) return { body: HANDOFF_BODY, handoff: true };
    return { body: text };
  }
}

/**
 * Projects the transcript onto the Messages API shape.
 *
 * `system` messages are dropped (they are UI notices, not conversation) and any
 * leading assistant turns are trimmed, because the API requires the first
 * message to come from the user.
 */
function toAnthropicMessages(
  transcript: Message[],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const mapped = transcript
    .filter((m) => m.senderType !== 'system' && m.body.trim().length > 0)
    .map((m) => ({
      role: m.senderType === 'visitor' ? ('user' as const) : ('assistant' as const),
      content: m.body,
    }));

  const firstUser = mapped.findIndex((m) => m.role === 'user');
  return firstUser === -1 ? [] : mapped.slice(firstUser);
}
