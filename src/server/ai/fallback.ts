/**
 * AI fallback timer table.
 *
 * When a visitor writes into a conversation nobody has claimed, we start a
 * clock. If an agent claims (or the chat closes) first, the timer is cancelled;
 * otherwise the assistant answers so the visitor is not left staring at silence.
 *
 * Timers live in memory, which means **one bridge per process** and a restart
 * drops pending fallbacks. That is a deliberate trade: the alternative is a
 * durable job queue, which is a dependency most installs do not want. A
 * multi-instance deployment should either pin a conversation to an instance or
 * replace this module with a scheduled job — the surface is just
 * `scheduleAiFallback` / `cancelAiFallback`.
 */

import type { SiteId } from '../../types.js';
import type { ResolvedConfig } from '../config.js';
import { publish } from '../events.js';
import { ConversationModel, MessageModel, toConversation, toMessage } from '../models/index.js';
import { appendMessage, asObjectId } from '../store.js';

/** Most recent messages handed to the provider as context. */
const TRANSCRIPT_LIMIT = 40;

const timers = new Map<string, ReturnType<typeof setTimeout>>();

function key(siteId: SiteId, conversationId: string): string {
  return `${siteId} ${conversationId}`;
}

export function cancelAiFallback(siteId: SiteId, conversationId: string): void {
  const k = key(siteId, conversationId);
  const handle = timers.get(k);
  if (handle === undefined) return;
  clearTimeout(handle);
  timers.delete(k);
}

/** Clears every pending timer. Used on shutdown and by tests. */
export function cancelAllAiFallbacks(): void {
  for (const handle of timers.values()) clearTimeout(handle);
  timers.clear();
}

/**
 * (Re)arms the fallback for one conversation. No-op when no provider is
 * configured, so an install without AI pays nothing for this module.
 */
export function scheduleAiFallback(
  config: ResolvedConfig,
  siteId: SiteId,
  conversationId: string,
): void {
  if (!config.ai) return;

  cancelAiFallback(siteId, conversationId);
  const k = key(siteId, conversationId);

  const handle = setTimeout(() => {
    timers.delete(k);
    void runFallback(config, siteId, conversationId).catch(() => {
      // A provider outage must never crash the process; the chat simply stays
      // open and waits for a human, which is the correct degraded behaviour.
    });
  }, config.aiFallbackMs);

  // Don't hold a serverless invocation (or a test runner) open on this timer.
  (handle as unknown as { unref?: () => void }).unref?.();

  timers.set(k, handle);
}

async function runFallback(
  config: ResolvedConfig,
  siteId: SiteId,
  conversationId: string,
): Promise<void> {
  const ai = config.ai;
  if (!ai) return;

  const _id = asObjectId(conversationId);
  if (!_id) return;

  const doc = await ConversationModel.findOne({ _id, siteId });
  // Re-check under the tenant filter: an agent may have claimed or closed the
  // chat while the timer was pending, in which case the AI must stay out.
  if (!doc || doc.status !== 'open') return;

  const transcript = await MessageModel.find({ siteId, conversationId })
    .sort({ seq: -1 })
    .limit(TRANSCRIPT_LIMIT);

  const result = await ai.reply({
    siteId,
    conversation: toConversation(doc),
    messages: transcript.reverse().map(toMessage),
    ...(config.aiSystemPrompt ? { systemPrompt: config.aiSystemPrompt } : {}),
  });

  const appended = await appendMessage({
    siteId,
    conversationId,
    senderType: 'ai',
    senderName: ai.name,
    body: result.body,
  });
  if (!appended) return;

  // On handoff the assistant declined, so the chat stays `open` and remains in
  // the agent queue. Otherwise it moves to `ai` and out of the "needs a human
  // right now" bucket.
  if (result.handoff) return;

  const updated = await ConversationModel.findOneAndUpdate(
    { _id, siteId, status: 'open' },
    // Consume a cursor slot so this envelope orders against the message stream.
    { $inc: { seqCounter: 1 }, $set: { status: 'ai' } },
    { new: true },
  );
  if (!updated) return;

  publish(siteId, conversationId, {
    event: 'conversation:updated',
    siteId,
    conversationId,
    data: { conversation: toConversation(updated) },
    seq: updated.seqCounter,
    at: new Date().toISOString(),
  });
}
