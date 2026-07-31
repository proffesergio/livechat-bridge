import type { AIProvider } from './types.js';

/**
 * OpenAI provider — STUB.
 *
 * Implement by mirroring `AnthropicProvider`: take a pre-constructed OpenAI
 * client, map history to `{ role, content }` (role is `'user'` or
 * `'assistant'`), and call `client.chat.completions.create`. Extract
 * `choices[0].message.content` for the reply body.
 */
export class OpenAIProvider implements AIProvider {
  readonly name = 'openai';

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_opts: { client: unknown; model?: string }) {
    throw new Error(
      'OpenAIProvider is not yet implemented. Use AnthropicProvider or implement AIProvider directly.'
    );
  }

  reply(): never {
    throw new Error('not implemented');
  }
}
