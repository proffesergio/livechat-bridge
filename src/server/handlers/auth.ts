import { pusherAuthInputSchema } from '../../core/index.js';
import type { LiveChatBridge } from '../bridge.js';
import { errorResponse, json } from './json.js';

/**
 * Pusher channel authorization. Pusher posts form-encoded `socket_id` and
 * `channel_name` — we accept either form or JSON for ergonomics.
 */
export async function handlePusherAuth(
  bridge: LiveChatBridge,
  req: Request
): Promise<Response> {
  try {
    const contentType = req.headers.get('content-type') ?? '';
    let raw: { socket_id?: string; channel_name?: string };
    if (contentType.includes('application/json')) {
      raw = await req.json();
    } else {
      const form = await req.formData();
      raw = {
        socket_id: String(form.get('socket_id') ?? ''),
        channel_name: String(form.get('channel_name') ?? ''),
      };
    }
    const { socket_id, channel_name } = pusherAuthInputSchema.parse(raw);
    const auth = await bridge.authorize(req, socket_id, channel_name);
    return json(auth);
  } catch (err) {
    return errorResponse(err);
  }
}
