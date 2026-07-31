/**
 * Pusher event names. Centralized so widget, admin, and server stay in sync.
 *
 * Channels:
 *   - `private-chat-<chatId>`  : per-chat stream (messages, typing, status)
 *   - `presence-staff`         : staff online presence + queue broadcasts
 */
export const EVENTS = {
  MESSAGE_NEW: 'message:new',
  MESSAGE_AI: 'message:ai',
  CHAT_CLAIMED: 'chat:claimed',
  CHAT_CLOSED: 'chat:closed',
  CHAT_AI_TAKEOVER: 'chat:ai-takeover',
  CHAT_STAFF_TAKEOVER: 'chat:staff-takeover',
  TYPING: 'client-typing',
  QUEUE_UPDATED: 'queue:updated',
} as const;

export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

export function chatChannel(chatId: string): string {
  return `private-chat-${chatId}`;
}

export const STAFF_CHANNEL = 'presence-staff';
