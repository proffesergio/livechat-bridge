import type { Chat, Message, SenderType, UserRef } from './schemas.js';

/** Identity returned by `getViewer()` — used to gate access and label messages. */
export interface Viewer {
  id: string;
  name: string;
  email?: string;
  avatarUrl?: string;
  /** True if this viewer should see the admin dashboard and may claim chats. */
  isStaff: boolean;
}

export type ViewerResolver = (req: Request) => Promise<Viewer | null> | Viewer | null;

/** Optional locale code, e.g. `'en'` or `'bn'`. */
export type Locale = string;

/** Event payloads emitted onto Pusher channels. */
export interface MessagePayload {
  message: Message;
  chat: Pick<Chat, 'id' | 'status' | 'assignedStaffId'>;
}

export interface ClaimedPayload {
  chatId: string;
  staffId: string;
  staffName: string;
  at: string;
}

export interface AiTakeoverPayload {
  chatId: string;
  at: string;
}

export interface StaffTakeoverPayload {
  chatId: string;
  staffId: string;
  staffName: string;
  at: string;
}

export interface QueueUpdatedPayload {
  open: number;
  claimed: number;
  ai: number;
}

export interface ClosedPayload {
  chatId: string;
  at: string;
}

export type AnyEventPayload =
  | MessagePayload
  | ClaimedPayload
  | AiTakeoverPayload
  | StaffTakeoverPayload
  | QueueUpdatedPayload
  | ClosedPayload;

/** Re-exports for ergonomic imports. */
export type { Chat, Message, SenderType, UserRef };
