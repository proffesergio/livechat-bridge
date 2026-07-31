import {
  createLiveChatBridge,
  MemoryStorage,
  SSETransport,
  type LiveChatBridge,
} from 'livechat-bridge/server';
import { buildAi } from './ai';
import { readSession } from './session';

declare global {
  // The bridge holds in-memory AI fallback timers, so it MUST be a process
  // singleton. Stash it on `globalThis` to survive Next.js's dev-mode module
  // reloading.
  // eslint-disable-next-line no-var
  var __lcbBridge: Promise<LiveChatBridge> | undefined;
}

async function createBridge(): Promise<LiveChatBridge> {
  const ai = await buildAi();
  const fallback = Number(process.env.AI_FALLBACK_MS);
  return createLiveChatBridge({
    storage: new MemoryStorage(),
    transport: new SSETransport(),
    ai,
    aiFallbackMs: Number.isFinite(fallback) && fallback >= 0 ? fallback : undefined,
    aiSystemPrompt:
      "You are the demo assistant for the livechat-bridge example app. Be warm, brief, and " +
      "tell the user that a human teammate will follow up shortly.",
    getViewer: async (req) => {
      const s = readSession(req);
      if (!s) return null;
      return { id: s.id, name: s.name, email: s.email, isStaff: s.isStaff };
    },
  });
}

export function getBridge(): Promise<LiveChatBridge> {
  if (!globalThis.__lcbBridge) {
    globalThis.__lcbBridge = createBridge();
  }
  return globalThis.__lcbBridge;
}
