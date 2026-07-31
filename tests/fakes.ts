import { CHAT_STATUS, SENDER_TYPE, type Viewer } from '../src/core/index.js';
import type { AIProvider, AiReplyContext, AiReplyResult } from '../src/server/adapters/ai/index.js';
import type { Transport } from '../src/server/transport/index.js';

export class FakeTransport implements Transport {
  public triggers: { channel: string; event: string; payload: unknown }[] = [];

  async trigger(channel: string, event: string, payload: unknown): Promise<void> {
    this.triggers.push({ channel, event, payload });
  }

  authorizeChannel(): Record<string, unknown> {
    return { auth: 'fake' };
  }
}

export class FakeAi implements AIProvider {
  readonly name = 'fake';
  public calls: AiReplyContext[] = [];
  constructor(private readonly body = 'Thanks for reaching out — a human will follow up soon.') {}

  async reply(ctx: AiReplyContext): Promise<AiReplyResult> {
    this.calls.push(ctx);
    return { body: this.body };
  }
}

export function fakeRequest(): Request {
  return new Request('http://test.local/livechat');
}

export function makeViewer(overrides: Partial<Viewer> & { id: string; name: string }): Viewer {
  return { isStaff: false, ...overrides };
}

export const SENDER = SENDER_TYPE;
export const STATUS = CHAT_STATUS;
