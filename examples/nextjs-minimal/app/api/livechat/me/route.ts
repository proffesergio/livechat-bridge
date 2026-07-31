import { createRouteHandlers } from 'livechat-bridge/server/nextjs';
import { getBridge } from '../../../lib/livechat';

export async function GET(req: Request): Promise<Response> {
  return createRouteHandlers(await getBridge()).viewer(req);
}
