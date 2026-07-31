import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_LENGTH,
  chatSchema,
  messageSchema,
  sendMessageInputSchema,
} from '../src/core/index.js';

describe('schemas', () => {
  it('accepts a well-formed message payload', () => {
    expect(() =>
      sendMessageInputSchema.parse({ chatId: 'c1', body: 'hi there' })
    ).not.toThrow();
  });

  it('rejects empty message bodies', () => {
    expect(() => sendMessageInputSchema.parse({ body: '' })).toThrow();
  });

  it('rejects oversize messages', () => {
    expect(() =>
      sendMessageInputSchema.parse({ body: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) })
    ).toThrow();
  });

  it('coerces date strings on Chat / Message', () => {
    const chat = chatSchema.parse({
      id: 'c1',
      user: { id: 'u1', name: 'Alice' },
      status: 'open',
      createdAt: '2026-05-20T00:00:00Z',
      updatedAt: '2026-05-20T00:00:00Z',
    });
    expect(chat.createdAt).toBeInstanceOf(Date);

    const msg = messageSchema.parse({
      id: 'm1',
      chatId: 'c1',
      senderType: 'user',
      body: 'hi',
      createdAt: '2026-05-20T00:00:00Z',
    });
    expect(msg.createdAt).toBeInstanceOf(Date);
  });
});
