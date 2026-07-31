import type { LiveChatBridge } from '../bridge.js';
import { errorResponse, json } from './json.js';

export async function handleListChats(
  bridge: LiveChatBridge,
  req: Request
): Promise<Response> {
  try {
    const url = new URL(req.url);
    const result = await bridge.listChats(req, url.searchParams);
    return json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleClaimChat(
  bridge: LiveChatBridge,
  req: Request,
  chatId: string
): Promise<Response> {
  try {
    const chat = await bridge.claimChat(req, chatId);
    return json({ chat });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleCloseChat(
  bridge: LiveChatBridge,
  req: Request,
  chatId: string
): Promise<Response> {
  try {
    const chat = await bridge.closeChat(req, chatId);
    return json({ chat });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleViewer(
  bridge: LiveChatBridge,
  req: Request
): Promise<Response> {
  try {
    const viewer = await bridge.getViewer(req);
    return json({ viewer });
  } catch (err) {
    return errorResponse(err);
  }
}
