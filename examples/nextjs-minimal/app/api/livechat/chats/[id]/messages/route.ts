import { createRouteHandlers, type RouteContext } from 'livechat-bridge/server/nextjs';
import { getBridge } from '../../../../../lib/livechat';

export async function GET(req: Request, ctx: RouteContext<{ id: string }>): Promise<Response> {
  return createRouteHandlers(await getBridge()).listMessages(req, ctx);
}
