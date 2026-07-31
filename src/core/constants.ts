/**
 * Timing & limits used by both server and client.
 *
 * `AI_FALLBACK_MS` is the grace window the system waits for a human staff
 * member to claim a chat before the AI assistant steps in. Keep this in sync
 * with the README.
 */
export const AI_FALLBACK_MS = 30_000;

export const TYPING_DEBOUNCE_MS = 1_500;

export const MAX_MESSAGE_LENGTH = 4_000;

export const DEFAULT_PAGE_SIZE = 30;

export const CHAT_STATUS = {
  OPEN: 'open',
  CLAIMED: 'claimed',
  AI: 'ai',
  CLOSED: 'closed',
} as const;

export const SENDER_TYPE = {
  USER: 'user',
  STAFF: 'staff',
  AI: 'ai',
  SYSTEM: 'system',
} as const;
