import type { Message } from '../../../core/index.js';

export interface AiReplyContext {
  /** System prompt describing the brand, tone, and escalation rules. */
  systemPrompt: string;
  /** History to include — most recent last. */
  history: Pick<Message, 'senderType' | 'body'>[];
  /** Optional locale hint, e.g. `'en'` or `'bn'`. */
  locale?: string;
  /** Abort signal for cancellation (e.g. a staff member claimed the chat). */
  signal?: AbortSignal;
}

export interface AiReplyResult {
  body: string;
  /** Provider-specific metadata. Stored on the message but never displayed. */
  meta?: Record<string, unknown>;
}

export interface AIProvider {
  readonly name: string;
  reply(ctx: AiReplyContext): Promise<AiReplyResult>;
}
