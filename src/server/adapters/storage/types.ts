import type { Chat, ChatStatus, Message, UserRef } from '../../../core/index.js';

export interface ListChatsOptions {
  status?: ChatStatus;
  cursor?: string;
  limit?: number;
}

export interface ListChatsResult {
  chats: Chat[];
  nextCursor?: string;
}

export interface ListMessagesOptions {
  cursor?: string;
  limit?: number;
}

export interface ListMessagesResult {
  messages: Message[];
  nextCursor?: string;
}

export interface QueueCounts {
  open: number;
  claimed: number;
  ai: number;
}

/**
 * Persistence boundary. All server handlers go through this — there is no
 * direct database access anywhere else. Implement this to plug in Postgres,
 * Redis, DynamoDB, etc.
 */
export interface StorageAdapter {
  /** Return the open or claimed chat for this user, if any. */
  findActiveChatByUser(userId: string): Promise<Chat | null>;

  createChat(input: { user: UserRef; meta?: Record<string, unknown> }): Promise<Chat>;
  getChat(chatId: string): Promise<Chat | null>;
  updateChat(chatId: string, patch: Partial<Chat>): Promise<Chat>;
  listChats(opts: ListChatsOptions): Promise<ListChatsResult>;

  /**
   * Atomically claim a chat for `staffId`, but only if it is not already
   * claimed by someone else. Return the updated chat, or `null` if the claim
   * was lost to another staff member.
   */
  claimChat(chatId: string, staffId: string): Promise<Chat | null>;

  appendMessage(message: Message): Promise<Message>;
  listMessages(chatId: string, opts: ListMessagesOptions): Promise<ListMessagesResult>;

  getQueueCounts(): Promise<QueueCounts>;
}
