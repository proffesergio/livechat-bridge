import {
  AI_FALLBACK_MS,
  CHAT_STATUS,
  EVENTS,
  SENDER_TYPE,
  STAFF_CHANNEL,
  chatChannel,
  ChatAlreadyClaimedError,
  NotFoundError,
  UnauthorizedError,
  createId,
  type Chat,
  type Message,
  type SendMessageInput,
  type ViewerResolver,
  type Viewer,
} from '../core/index.js';
import type { StorageAdapter } from './adapters/storage/index.js';
import type { AIProvider } from './adapters/ai/index.js';
import type { Transport } from './transport/index.js';
import { AiScheduler } from './ai-scheduler.js';

export interface BridgeConfig {
  storage: StorageAdapter;
  transport: Transport;
  ai?: AIProvider;
  getViewer: ViewerResolver;
  /**
   * System prompt for the AI assistant. Receives a `{brand}` placeholder if
   * provided; otherwise it is used verbatim.
   */
  aiSystemPrompt?: string;
  /** Override the default 30 s grace window. Set to `0` to disable AI fallback. */
  aiFallbackMs?: number;
  /** Default locale to use when the user has no preference. */
  defaultLocale?: string;
}

const DEFAULT_SYSTEM_PROMPT = `You are a friendly customer support assistant standing in for a human staff member who is briefly unavailable. Be concise, warm, and honest about what you can and can't help with. If the user has a complex or sensitive question (refunds, account changes, anything legal or medical), tell them clearly that a human teammate will follow up shortly and ask for any details that would help that teammate.`;

export interface LiveChatBridge {
  readonly config: BridgeConfig;
  sendMessage(req: Request, input: SendMessageInput): Promise<Message>;
  claimChat(req: Request, chatId: string): Promise<Chat>;
  closeChat(req: Request, chatId: string): Promise<Chat>;
  listChats(req: Request, params: URLSearchParams): Promise<{ chats: Chat[]; nextCursor?: string }>;
  listMessages(
    req: Request,
    chatId: string,
    params: URLSearchParams
  ): Promise<{ messages: Message[]; nextCursor?: string }>;
  authorize(req: Request, socketId: string, channel: string): Promise<Record<string, unknown>>;
  /**
   * Resolve the viewer and assert they may subscribe to `channel`, throwing if
   * not. Used by the SSE stream handler (which has no socket handshake) and
   * shared with {@link LiveChatBridge.authorize}.
   */
  authorizeSubscription(req: Request, channel: string): Promise<Viewer>;
  getViewer(req: Request): Promise<Viewer>;
  /** Test helper. */
  readonly _scheduler: AiScheduler;
}

export function createLiveChatBridge(config: BridgeConfig): LiveChatBridge {
  const scheduler = new AiScheduler();
  const fallbackMs = config.aiFallbackMs ?? AI_FALLBACK_MS;
  const systemPrompt = config.aiSystemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  async function resolveViewer(req: Request): Promise<Viewer> {
    const v = await config.getViewer(req);
    if (!v) throw new UnauthorizedError();
    return v;
  }

  async function assertChannelAccess(viewer: Viewer, channel: string): Promise<void> {
    if (channel === STAFF_CHANNEL && !viewer.isStaff) {
      throw new UnauthorizedError('Staff only');
    }
    if (channel.startsWith('private-chat-')) {
      const chatId = channel.slice('private-chat-'.length);
      const chat = await config.storage.getChat(chatId);
      if (!chat) throw new NotFoundError('Chat');
      if (!viewer.isStaff && chat.user.id !== viewer.id) throw new UnauthorizedError();
    }
  }

  async function broadcastQueue(): Promise<void> {
    const counts = await config.storage.getQueueCounts();
    await config.transport.trigger(STAFF_CHANNEL, EVENTS.QUEUE_UPDATED, counts);
  }

  async function runAiReply(chatId: string, signal: AbortSignal): Promise<void> {
    if (!config.ai) return;
    // Re-read the chat — another instance may have claimed it in the meantime.
    const chat = await config.storage.getChat(chatId);
    if (!chat || chat.status !== CHAT_STATUS.OPEN) return;

    await config.storage.updateChat(chatId, {
      status: CHAT_STATUS.AI,
      aiTakeoverAt: new Date(),
    });
    await config.transport.trigger(chatChannel(chatId), EVENTS.CHAT_AI_TAKEOVER, {
      chatId,
      at: new Date().toISOString(),
    });

    const { messages } = await config.storage.listMessages(chatId, { limit: 20 });
    const result = await config.ai.reply({
      systemPrompt,
      history: messages.map((m) => ({ senderType: m.senderType, body: m.body })),
      locale: config.defaultLocale,
      signal,
    });

    const aiMessage: Message = {
      id: createId('msg'),
      chatId,
      senderType: SENDER_TYPE.AI,
      senderName: 'Assistant',
      body: result.body,
      createdAt: new Date(),
      meta: result.meta,
    };
    await config.storage.appendMessage(aiMessage);
    await config.transport.trigger(chatChannel(chatId), EVENTS.MESSAGE_AI, {
      message: aiMessage,
      chat: { id: chatId, status: CHAT_STATUS.AI, assignedStaffId: undefined },
    });
    await broadcastQueue();
  }

  return {
    config,
    _scheduler: scheduler,

    async getViewer(req) {
      return resolveViewer(req);
    },

    async sendMessage(req, input) {
      const viewer = await resolveViewer(req);

      let chat: Chat | null = null;
      if (input.chatId) {
        chat = await config.storage.getChat(input.chatId);
        if (!chat) throw new NotFoundError('Chat');
        if (!viewer.isStaff && chat.user.id !== viewer.id) {
          throw new UnauthorizedError('Not your chat');
        }
      } else {
        if (viewer.isStaff) throw new UnauthorizedError('Staff cannot start chats');
        chat = await config.storage.findActiveChatByUser(viewer.id);
        chat ??= await config.storage.createChat({
          user: {
            id: viewer.id,
            name: viewer.name,
            email: viewer.email,
            avatarUrl: viewer.avatarUrl,
          },
        });
      }

      const message: Message = {
        id: createId('msg'),
        chatId: chat.id,
        senderType: viewer.isStaff ? SENDER_TYPE.STAFF : SENDER_TYPE.USER,
        senderId: viewer.id,
        senderName: viewer.name,
        body: input.body,
        createdAt: new Date(),
      };
      await config.storage.appendMessage(message);

      // Staff posting in an AI-handled chat → take over.
      if (viewer.isStaff && chat.status === CHAT_STATUS.AI) {
        scheduler.cancel(chat.id);
        chat = await config.storage.updateChat(chat.id, {
          status: CHAT_STATUS.CLAIMED,
          assignedStaffId: viewer.id,
        });
        await config.transport.trigger(chatChannel(chat.id), EVENTS.CHAT_STAFF_TAKEOVER, {
          chatId: chat.id,
          staffId: viewer.id,
          staffName: viewer.name,
          at: new Date().toISOString(),
        });
        await broadcastQueue();
      }

      await config.transport.trigger(chatChannel(chat.id), EVENTS.MESSAGE_NEW, {
        message,
        chat: { id: chat.id, status: chat.status, assignedStaffId: chat.assignedStaffId },
      });

      // First user message in an OPEN chat → start fallback timer.
      if (
        !viewer.isStaff &&
        chat.status === CHAT_STATUS.OPEN &&
        config.ai &&
        fallbackMs > 0
      ) {
        scheduler.schedule(chat.id, fallbackMs, (signal) => runAiReply(chat!.id, signal));
        await broadcastQueue();
      }

      return message;
    },

    async claimChat(req, chatId) {
      const viewer = await resolveViewer(req);
      if (!viewer.isStaff) throw new UnauthorizedError('Only staff may claim chats');

      const claimed = await config.storage.claimChat(chatId, viewer.id);
      if (!claimed) throw new ChatAlreadyClaimedError();

      scheduler.cancel(chatId);

      await config.transport.trigger(chatChannel(chatId), EVENTS.CHAT_CLAIMED, {
        chatId,
        staffId: viewer.id,
        staffName: viewer.name,
        at: new Date().toISOString(),
      });
      await broadcastQueue();
      return claimed;
    },

    async closeChat(req, chatId) {
      const viewer = await resolveViewer(req);
      const chat = await config.storage.getChat(chatId);
      if (!chat) throw new NotFoundError('Chat');
      const isOwner = chat.user.id === viewer.id;
      if (!viewer.isStaff && !isOwner) throw new UnauthorizedError();

      scheduler.cancel(chatId);
      const closed = await config.storage.updateChat(chatId, {
        status: CHAT_STATUS.CLOSED,
        closedAt: new Date(),
      });
      await config.transport.trigger(chatChannel(chatId), EVENTS.CHAT_CLOSED, {
        chatId,
        at: new Date().toISOString(),
      });
      await broadcastQueue();
      return closed;
    },

    async listChats(req, params) {
      const viewer = await resolveViewer(req);
      if (!viewer.isStaff) throw new UnauthorizedError('Staff only');
      const status = params.get('status') as Chat['status'] | null;
      const cursor = params.get('cursor') ?? undefined;
      const limit = params.get('limit') ? Number(params.get('limit')) : undefined;
      return config.storage.listChats({
        status: status ?? undefined,
        cursor,
        limit,
      });
    },

    async listMessages(req, chatId, params) {
      const viewer = await resolveViewer(req);
      const chat = await config.storage.getChat(chatId);
      if (!chat) throw new NotFoundError('Chat');
      if (!viewer.isStaff && chat.user.id !== viewer.id) throw new UnauthorizedError();
      const cursor = params.get('cursor') ?? undefined;
      const limit = params.get('limit') ? Number(params.get('limit')) : undefined;
      return config.storage.listMessages(chatId, { cursor, limit });
    },

    async authorizeSubscription(req, channel) {
      const viewer = await resolveViewer(req);
      await assertChannelAccess(viewer, channel);
      return viewer;
    },

    async authorize(req, socketId, channel) {
      const viewer = await resolveViewer(req);
      await assertChannelAccess(viewer, channel);
      return config.transport.authorizeChannel(socketId, channel, {
        id: viewer.id,
        name: viewer.name,
        isStaff: viewer.isStaff,
      });
    },
  };
}
