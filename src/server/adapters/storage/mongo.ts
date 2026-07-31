import type { Mongoose, Model } from 'mongoose';
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

interface ChatDoc {
  _id: string;
  user: UserRef;
  status: Chat['status'];
  assignedStaffId?: string;
  lastMessageAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  aiTakeoverAt?: Date;
  closedAt?: Date;
  meta?: Record<string, unknown>;
}

interface MessageDoc {
  _id: string;
  chatId: string;
  senderType: Message['senderType'];
  senderId?: string;
  senderName?: string;
  body: string;
  createdAt: Date;
  meta?: Record<string, unknown>;
}

function chatFromDoc(doc: ChatDoc): Chat {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

function messageFromDoc(doc: MessageDoc): Message {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

export interface MongoStorageOptions {
  mongoose: Mongoose;
  chatCollection?: string;
  messageCollection?: string;
}

/**
 * Mongoose-backed storage adapter. Models are registered lazily on construction
 * so callers can pass their already-connected `mongoose` instance.
 */
export class MongoStorage implements StorageAdapter {
  private readonly ChatModel: Model<ChatDoc>;
  private readonly MessageModel: Model<MessageDoc>;

  constructor({ mongoose, chatCollection, messageCollection }: MongoStorageOptions) {
    const chatName = chatCollection ?? 'livechat_chats';
    const msgName = messageCollection ?? 'livechat_messages';

    this.ChatModel =
      (mongoose.models[chatName] as Model<ChatDoc> | undefined) ??
      mongoose.model<ChatDoc>(
        chatName,
        new mongoose.Schema<ChatDoc>(
          {
            _id: { type: String, required: true },
            user: {
              id: { type: String, required: true },
              name: { type: String, required: true },
              email: String,
              avatarUrl: String,
            },
            status: { type: String, required: true, index: true },
            assignedStaffId: { type: String, index: true },
            lastMessageAt: Date,
            createdAt: { type: Date, required: true },
            updatedAt: { type: Date, required: true },
            aiTakeoverAt: Date,
            closedAt: Date,
            meta: mongoose.Schema.Types.Mixed,
          },
          { _id: false, collection: chatName }
        )
      );

    this.MessageModel =
      (mongoose.models[msgName] as Model<MessageDoc> | undefined) ??
      mongoose.model<MessageDoc>(
        msgName,
        new mongoose.Schema<MessageDoc>(
          {
            _id: { type: String, required: true },
            chatId: { type: String, required: true, index: true },
            senderType: { type: String, required: true },
            senderId: String,
            senderName: String,
            body: { type: String, required: true },
            createdAt: { type: Date, required: true },
            meta: mongoose.Schema.Types.Mixed,
          },
          { _id: false, collection: msgName }
        )
      );
  }

  async findActiveChatByUser(userId: string): Promise<Chat | null> {
    const doc = await this.ChatModel.findOne({
      'user.id': userId,
      status: { $ne: CHAT_STATUS.CLOSED },
    }).lean<ChatDoc>();
    return doc ? chatFromDoc(doc) : null;
  }

  async createChat({
    user,
    meta,
  }: {
    user: UserRef;
    meta?: Record<string, unknown>;
  }): Promise<Chat> {
    const now = new Date();
    const id = createId('chat');
    await this.ChatModel.create({
      _id: id,
      user,
      status: CHAT_STATUS.OPEN,
      createdAt: now,
      updatedAt: now,
      meta,
    });
    return {
      id,
      user,
      status: CHAT_STATUS.OPEN,
      createdAt: now,
      updatedAt: now,
      meta,
    };
  }

  async getChat(chatId: string): Promise<Chat | null> {
    const doc = await this.ChatModel.findById(chatId).lean<ChatDoc>();
    return doc ? chatFromDoc(doc) : null;
  }

  async updateChat(chatId: string, patch: Partial<Chat>): Promise<Chat> {
    const { id: _ignored, ...rest } = patch;
    const doc = await this.ChatModel.findByIdAndUpdate(
      chatId,
      { ...rest, updatedAt: new Date() },
      { new: true }
    ).lean<ChatDoc>();
    if (!doc) throw new Error(`Chat ${chatId} not found`);
    return chatFromDoc(doc);
  }

  async listChats(opts: ListChatsOptions): Promise<ListChatsResult> {
    const limit = opts.limit ?? 30;
    const filter: Record<string, unknown> = {};
    if (opts.status) filter.status = opts.status;
    if (opts.cursor) filter._id = { $lt: opts.cursor };
    const docs = await this.ChatModel.find(filter)
      .sort({ updatedAt: -1 })
      .limit(limit + 1)
      .lean<ChatDoc[]>();
    const hasMore = docs.length > limit;
    const page = (hasMore ? docs.slice(0, limit) : docs).map(chatFromDoc);
    const nextCursor = hasMore ? page[page.length - 1]?.id : undefined;
    return { chats: page, nextCursor };
  }

  async claimChat(chatId: string, staffId: string): Promise<Chat | null> {
    const doc = await this.ChatModel.findOneAndUpdate(
      {
        _id: chatId,
        $or: [{ assignedStaffId: { $exists: false } }, { assignedStaffId: staffId }],
      },
      {
        $set: {
          status: CHAT_STATUS.CLAIMED,
          assignedStaffId: staffId,
          updatedAt: new Date(),
        },
        $unset: { aiTakeoverAt: '' },
      },
      { new: true }
    ).lean<ChatDoc>();
    return doc ? chatFromDoc(doc) : null;
  }

  async appendMessage(message: Message): Promise<Message> {
    await this.MessageModel.create({
      _id: message.id,
      chatId: message.chatId,
      senderType: message.senderType,
      senderId: message.senderId,
      senderName: message.senderName,
      body: message.body,
      createdAt: message.createdAt,
      meta: message.meta,
    });
    await this.ChatModel.updateOne(
      { _id: message.chatId },
      { $set: { lastMessageAt: message.createdAt, updatedAt: new Date() } }
    );
    return message;
  }

  async listMessages(
    chatId: string,
    opts: ListMessagesOptions
  ): Promise<ListMessagesResult> {
    const limit = opts.limit ?? 30;
    const filter: Record<string, unknown> = { chatId };
    if (opts.cursor) filter._id = { $lt: opts.cursor };
    const docs = await this.MessageModel.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean<MessageDoc[]>();
    const hasMore = docs.length > limit;
    const page = (hasMore ? docs.slice(0, limit) : docs)
      .map(messageFromDoc)
      .reverse();
    const nextCursor = hasMore ? page[0]?.id : undefined;
    return { messages: page, nextCursor };
  }

  async getQueueCounts(): Promise<QueueCounts> {
    const rows = await this.ChatModel.aggregate<{ _id: string; count: number }>([
      { $match: { status: { $in: [CHAT_STATUS.OPEN, CHAT_STATUS.CLAIMED, CHAT_STATUS.AI] } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const counts: QueueCounts = { open: 0, claimed: 0, ai: 0 };
    for (const r of rows) {
      if (r._id === CHAT_STATUS.OPEN) counts.open = r.count;
      else if (r._id === CHAT_STATUS.CLAIMED) counts.claimed = r.count;
      else if (r._id === CHAT_STATUS.AI) counts.ai = r.count;
    }
    return counts;
  }
}
