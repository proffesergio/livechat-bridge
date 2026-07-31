/**
 * AI fallback scheduler.
 *
 * When a user posts the first message of a new chat (or the first one in a
 * while), we set a timer. If a human staff member claims the chat before it
 * fires, the timer is cancelled and the chat is human-handled. If it does
 * fire, the AI provider takes over.
 *
 * Timers are stored in-process. In a multi-instance deployment this is fine
 * because (a) only one instance receives any given `sendMessage` call, and
 * (b) `claimChat` is atomic in the storage adapter — the worst case is one
 * instance fires an AI reply for a chat another instance just claimed, which
 * we double-check inside `runAiReply` by re-reading chat state.
 */
export class AiScheduler {
  private timers = new Map<string, NodeJS.Timeout>();
  private controllers = new Map<string, AbortController>();

  schedule(chatId: string, delayMs: number, fn: (signal: AbortSignal) => Promise<void>): void {
    this.cancel(chatId);
    const controller = new AbortController();
    this.controllers.set(chatId, controller);
    const timer = setTimeout(() => {
      this.timers.delete(chatId);
      fn(controller.signal).catch((err) => {
        if (controller.signal.aborted) return;
        // eslint-disable-next-line no-console
        console.error(`[livechat-bridge] AI fallback failed for chat ${chatId}:`, err);
      });
    }, delayMs);
    this.timers.set(chatId, timer);
  }

  cancel(chatId: string): void {
    const t = this.timers.get(chatId);
    if (t) {
      clearTimeout(t);
      this.timers.delete(chatId);
    }
    const c = this.controllers.get(chatId);
    if (c) {
      c.abort();
      this.controllers.delete(chatId);
    }
  }

  /** Test helper — clear everything. */
  reset(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const c of this.controllers.values()) c.abort();
    this.timers.clear();
    this.controllers.clear();
  }
}
