import {
  CHAT_STATUS,
  type Chat,
  type Message,
  type UserRef,
  createId,
} from '../../../core/index.js';
import type {
  ListChatsOptions,
  ListChatsResult,
  ListMessagesOptions,
  ListMessagesResult,
  QueueCounts,
  StorageAdapter,
} from './types.js';

/**
 * In-memory storage. Useful for tests, demos, and local development.
 * NOT suitable for production — state vanishes when the process restarts and
 * is not shared across instances.
 */
export class MemoryStorage implements StorageAdapter {
  private chats = new Map<string, Chat>();
  private messages = new Map<string, Message[]>();

  async findActiveChatByUser(userId: string): Promise<Chat | null> {
    for (const chat of this.chats.values()) {
      if (chat.user.id !== userId) continue;
      if (chat.status === CHAT_STATUS.CLOSED) continue;
      return chat;
    }
    return null;
  }

  async createChat({
    user,
    meta,
  }: {
    user: UserRef;
    meta?: Record<string, unknown>;
  }): Promise<Chat> {
    const now = new Date();
    const chat: Chat = {
      id: createId('chat'),
      user,
      status: CHAT_STATUS.OPEN,
      createdAt: now,
      updatedAt: now,
      meta,
    };
    this.chats.set(chat.id, chat);
    this.messages.set(chat.id, []);
    return chat;
  }

  async getChat(chatId: string): Promise<Chat | null> {
    return this.chats.get(chatId) ?? null;
  }

  async updateChat(chatId: string, patch: Partial<Chat>): Promise<Chat> {
    const existing = this.chats.get(chatId);
    if (!existing) throw new Error(`Chat ${chatId} not found`);
    const updated: Chat = { ...existing, ...patch, updatedAt: new Date() };
    this.chats.set(chatId, updated);
    return updated;
  }

  async listChats(opts: ListChatsOptions): Promise<ListChatsResult> {
    const limit = opts.limit ?? 30;
    const all = [...this.chats.values()]
      .filter((c) => (opts.status ? c.status === opts.status : true))
      .sort((a, b) => +b.updatedAt - +a.updatedAt);
    const startIdx = opts.cursor
      ? all.findIndex((c) => c.id === opts.cursor) + 1
      : 0;
    const page = all.slice(startIdx, startIdx + limit);
    const nextCursor =
      startIdx + limit < all.length ? page[page.length - 1]?.id : undefined;
    return { chats: page, nextCursor };
  }

  async claimChat(chatId: string, staffId: string): Promise<Chat | null> {
    const chat = this.chats.get(chatId);
    if (!chat) return null;
    if (chat.assignedStaffId && chat.assignedStaffId !== staffId) return null;
    const updated: Chat = {
      ...chat,
      status: CHAT_STATUS.CLAIMED,
      assignedStaffId: staffId,
      aiTakeoverAt: undefined,
      updatedAt: new Date(),
    };
    this.chats.set(chatId, updated);
    return updated;
  }

  async appendMessage(message: Message): Promise<Message> {
    const bucket = this.messages.get(message.chatId) ?? [];
    bucket.push(message);
    this.messages.set(message.chatId, bucket);
    const chat = this.chats.get(message.chatId);
    if (chat) {
      this.chats.set(message.chatId, {
        ...chat,
        lastMessageAt: message.createdAt,
        updatedAt: new Date(),
      });
    }
    return message;
  }

  async listMessages(
    chatId: string,
    opts: ListMessagesOptions
  ): Promise<ListMessagesResult> {
    const limit = opts.limit ?? 30;
    const all = this.messages.get(chatId) ?? [];
    const startIdx = opts.cursor
      ? all.findIndex((m) => m.id === opts.cursor) + 1
      : 0;
    const page = all.slice(startIdx, startIdx + limit);
    const nextCursor =
      startIdx + limit < all.length ? page[page.length - 1]?.id : undefined;
    return { messages: page, nextCursor };
  }

  async getQueueCounts(): Promise<QueueCounts> {
    let open = 0;
    let claimed = 0;
    let ai = 0;
    for (const c of this.chats.values()) {
      if (c.status === CHAT_STATUS.OPEN) open++;
      else if (c.status === CHAT_STATUS.CLAIMED) claimed++;
      else if (c.status === CHAT_STATUS.AI) ai++;
    }
    return { open, claimed, ai };
  }
}
