import { sendMessageInputSchema } from '../../core/index.js';
import type { LiveChatBridge } from '../bridge.js';
import { errorResponse, json, readJson } from './json.js';

export async function handleSendMessage(
  bridge: LiveChatBridge,
  req: Request
): Promise<Response> {
  try {
    const body = await readJson(req);
    const parsed = sendMessageInputSchema.parse(body);
    const message = await bridge.sendMessage(req, parsed);
    return json({ message });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListMessages(
  bridge: LiveChatBridge,
  req: Request,
  chatId: string
): Promise<Response> {
  try {
    const url = new URL(req.url);
    const result = await bridge.listMessages(req, chatId, url.searchParams);
    return json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
