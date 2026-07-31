import { createRouteHandlers, type RouteContext } from 'livechat-bridge/server/nextjs';
import { getBridge } from '../../../../../lib/livechat';

export async function POST(req: Request, ctx: RouteContext<{ id: string }>): Promise<Response> {
  return createRouteHandlers(await getBridge()).closeChat(req, ctx);
}
