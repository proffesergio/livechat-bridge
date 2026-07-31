import { createRouteHandlers } from 'livechat-bridge/server/nextjs';
import { getBridge } from '../../../lib/livechat';

export async function POST(req: Request): Promise<Response> {
  return createRouteHandlers(await getBridge()).sendMessage(req);
}
