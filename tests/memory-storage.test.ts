import { describe, expect, it } from 'vitest';
import { CHAT_STATUS, SENDER_TYPE, createId } from '../src/core/index.js';
import { MemoryStorage } from '../src/server/adapters/storage/index.js';

describe('MemoryStorage', () => {
  it('claims a chat atomically — second claim returns null', async () => {
    const s = new MemoryStorage();
    const chat = await s.createChat({ user: { id: 'u1', name: 'Alice' } });
    const a = await s.claimChat(chat.id, 'staff-a');
    const b = await s.claimChat(chat.id, 'staff-b');
    expect(a?.assignedStaffId).toBe('staff-a');
    expect(b).toBeNull();
  });

  it('returns one active chat per user', async () => {
    const s = new MemoryStorage();
    const c1 = await s.createChat({ user: { id: 'u1', name: 'Alice' } });
    const found = await s.findActiveChatByUser('u1');
    expect(found?.id).toBe(c1.id);
  });

  it('counts the queue by status', async () => {
    const s = new MemoryStorage();
    const a = await s.createChat({ user: { id: 'u1', name: 'Alice' } });
    const b = await s.createChat({ user: { id: 'u2', name: 'Bob' } });
    await s.claimChat(b.id, 'staff-1');
    await s.updateChat(a.id, { status: CHAT_STATUS.AI });
    expect(await s.getQueueCounts()).toEqual({ open: 0, claimed: 1, ai: 1 });
  });

  it('paginates messages newest-last', async () => {
    const s = new MemoryStorage();
    const c = await s.createChat({ user: { id: 'u1', name: 'Alice' } });
    for (let i = 0; i < 5; i++) {
      await s.appendMessage({
        id: createId('msg'),
        chatId: c.id,
        senderType: SENDER_TYPE.USER,
        body: `m${i}`,
        createdAt: new Date(Date.now() + i),
      });
    }
    const { messages } = await s.listMessages(c.id, { limit: 10 });
    expect(messages.map((m) => m.body)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
  });
});
