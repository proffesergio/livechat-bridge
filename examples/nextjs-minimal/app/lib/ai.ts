import type { AIProvider, AiReplyContext, AiReplyResult } from 'livechat-bridge/server';

/**
 * Offline fallback so the demo runs with zero API keys. Echoes a friendly,
 * canned reply that mentions the user's last message. Swap for the real
 * `AnthropicProvider` by setting `ANTHROPIC_API_KEY` (see `buildAi`).
 */
class FakeAi implements AIProvider {
  readonly name = 'fake';
  async reply(ctx: AiReplyContext): Promise<AiReplyResult> {
    const last = [...ctx.history].reverse().find((m) => m.senderType === 'user');
    const snippet = last ? `"${last.body.slice(0, 80)}"` : 'your message';
    return {
      body:
        `Hi! I'm the demo assistant standing in for the human team. I saw ${snippet}. ` +
        `A teammate will follow up — meanwhile, feel free to add any details that would help them.`,
    };
  }
}

export async function buildAi(): Promise<AIProvider> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return new FakeAi();

  const [{ default: Anthropic }, { AnthropicProvider }] = await Promise.all([
    import('@anthropic-ai/sdk'),
    import('livechat-bridge/server'),
  ]);
  const client = new Anthropic({ apiKey: key });
  return new AnthropicProvider({ client });
}
