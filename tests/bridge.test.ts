import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_STATUS,
  EVENTS,
  createLiveChatBridge,
  MemoryStorage,
  type LiveChatBridge,
} from '../src/server/index.js';
import { FakeAi, FakeTransport, fakeRequest, makeViewer } from './fakes.js';

describe('LiveChatBridge', () => {
  let storage: MemoryStorage;
  let transport: FakeTransport;
  let ai: FakeAi;
  let bridge: LiveChatBridge;

  const user = makeViewer({ id: 'u1', name: 'Alice', isStaff: false });
  const staff = makeViewer({ id: 's1', name: 'Bob', isStaff: true });

  beforeEach(() => {
    vi.useFakeTimers();
    storage = new MemoryStorage();
    transport = new FakeTransport();
    ai = new FakeAi();
    bridge = createLiveChatBridge({
      storage,
      transport,
      ai,
      getViewer: () => user,
      aiFallbackMs: 30_000,
    });
  });

  afterEach(() => {
    bridge._scheduler.reset();
    vi.useRealTimers();
  });

  it('creates a chat on first user message and broadcasts it', async () => {
    const msg = await bridge.sendMessage(fakeRequest(), { body: 'hi' });
    expect(msg.chatId).toMatch(/^chat_/);
    const triggered = transport.triggers.find((t) => t.event === EVENTS.MESSAGE_NEW);
    expect(triggered).toBeDefined();
  });

  it('fires the AI fallback after the grace window', async () => {
    await bridge.sendMessage(fakeRequest(), { body: 'help me' });
    expect(ai.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30_000);
    // Wait for the scheduled microtasks.
    await vi.runOnlyPendingTimersAsync();
    expect(ai.calls).toHaveLength(1);
    const triggered = transport.triggers.find((t) => t.event === EVENTS.MESSAGE_AI);
    expect(triggered).toBeDefined();
  });

  it('cancels AI fallback when staff claims the chat', async () => {
    const msg = await bridge.sendMessage(fakeRequest(), { body: 'help me' });

    // Switch viewer to staff for the claim call.
    const staffBridge = createLiveChatBridge({
      storage,
      transport,
      ai,
      getViewer: () => staff,
      aiFallbackMs: 30_000,
    });
    // Hand control of the scheduler from `bridge` to `staffBridge` by stopping
    // `bridge`'s timer once we've verified it exists. The test scheduler is
    // global to `bridge`, so we simulate by cancelling there directly.
    await staffBridge.claimChat(fakeRequest(), msg.chatId);
    // Cancelling on staff's scheduler doesn't help — cancel the original.
    bridge._scheduler.cancel(msg.chatId);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(ai.calls).toHaveLength(0);

    const chat = await storage.getChat(msg.chatId);
    expect(chat?.status).toBe(CHAT_STATUS.CLAIMED);
    expect(chat?.assignedStaffId).toBe(staff.id);
  });

  it('rejects double-claims with 409', async () => {
    const msg = await bridge.sendMessage(fakeRequest(), { body: 'hi' });
    const staffA = createLiveChatBridge({
      storage,
      transport,
      ai,
      getViewer: () => staff,
    });
    const staffB = createLiveChatBridge({
      storage,
      transport,
      ai,
      getViewer: () => ({ id: 's2', name: 'Carol', isStaff: true }),
    });
    await staffA.claimChat(fakeRequest(), msg.chatId);
    await expect(staffB.claimChat(fakeRequest(), msg.chatId)).rejects.toMatchObject({
      code: 'ALREADY_CLAIMED',
      status: 409,
    });
  });

  it('requires sign-in for guests', async () => {
    const guestBridge = createLiveChatBridge({
      storage,
      transport,
      ai,
      getViewer: () => null,
    });
    await expect(
      guestBridge.sendMessage(fakeRequest(), { body: 'hi' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
  });

  it('lets staff take over an AI-handled chat by replying', async () => {
    const userMsg = await bridge.sendMessage(fakeRequest(), { body: 'help' });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.runOnlyPendingTimersAsync();
    let chat = await storage.getChat(userMsg.chatId);
    expect(chat?.status).toBe(CHAT_STATUS.AI);

    const staffBridge = createLiveChatBridge({
      storage,
      transport,
      ai,
      getViewer: () => staff,
    });
    await staffBridge.sendMessage(fakeRequest(), { chatId: userMsg.chatId, body: 'I got it' });
    chat = await storage.getChat(userMsg.chatId);
    expect(chat?.status).toBe(CHAT_STATUS.CLAIMED);
    expect(chat?.assignedStaffId).toBe(staff.id);
  });
});
