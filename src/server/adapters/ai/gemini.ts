import type { AIProvider } from './types.js';

/**
 * Google Gemini provider — STUB.
 *
 * Implement using `@google/generative-ai`. Map history to Gemini's
 * `{ role: 'user' | 'model', parts: [{ text }] }` shape and call
 * `model.generateContent` with the system instruction.
 */
export class GeminiProvider implements AIProvider {
  readonly name = 'gemini';

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_opts: { client: unknown; model?: string }) {
    throw new Error(
      'GeminiProvider is not yet implemented. Use AnthropicProvider or implement AIProvider directly.'
    );
  }

  reply(): never {
    throw new Error('not implemented');
  }
}
