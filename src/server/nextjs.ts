import {
  handleClaimChat,
  handleCloseChat,
  handleListChats,
  handleListMessages,
  handlePusherAuth,
  handleSendMessage,
  handleStream,
  handleViewer,
} from './handlers/index.js';
import type { LiveChatBridge } from './bridge.js';

export type RouteContext<P extends Record<string, string> = Record<string, string>> = {
  params: Promise<P> | P;
};

async function resolveParams<P extends Record<string, string>>(
  ctx: RouteContext<P>
): Promise<P> {
  return ctx.params instanceof Promise ? await ctx.params : ctx.params;
}

/**
 * Build Next.js App Router route handlers for a configured bridge.
 *
 * Suggested route layout:
 *
 *   app/api/livechat/messages/route.ts         → POST sendMessage
 *   app/api/livechat/chats/route.ts            → GET listChats
 *   app/api/livechat/chats/[id]/messages/route.ts  → GET listMessages
 *   app/api/livechat/chats/[id]/claim/route.ts → POST claimChat
 *   app/api/livechat/chats/[id]/close/route.ts → POST closeChat
 *   app/api/livechat/pusher/auth/route.ts      → POST pusher authorize
 *   app/api/livechat/stream/route.ts           → GET SSE stream (SSETransport)
 *   app/api/livechat/me/route.ts               → GET viewer
 *
 * Each route file should import the matching handler from here and re-export
 * it as the HTTP-method name (e.g. `export const POST = handlers.sendMessage`).
 */
export function createRouteHandlers(bridge: LiveChatBridge) {
  return {
    sendMessage: (req: Request) => handleSendMessage(bridge, req),
    listChats: (req: Request) => handleListChats(bridge, req),
    listMessages: async (req: Request, ctx: RouteContext<{ id: string }>) => {
      const { id } = await resolveParams(ctx);
      return handleListMessages(bridge, req, id);
    },
    claimChat: async (req: Request, ctx: RouteContext<{ id: string }>) => {
      const { id } = await resolveParams(ctx);
      return handleClaimChat(bridge, req, id);
    },
    closeChat: async (req: Request, ctx: RouteContext<{ id: string }>) => {
      const { id } = await resolveParams(ctx);
      return handleCloseChat(bridge, req, id);
    },
    pusherAuth: (req: Request) => handlePusherAuth(bridge, req),
    stream: (req: Request) => handleStream(bridge, req),
    viewer: (req: Request) => handleViewer(bridge, req),
  };
}

export type LiveChatRouteHandlers = ReturnType<typeof createRouteHandlers>;
