import { createRouteHandlers } from 'livechat-bridge/server/nextjs';
import { getBridge } from '../../../lib/livechat';

// SSE streams must run on the Node runtime (not the edge) so the underlying
// pub/sub timers and abort signal hand-off work correctly.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request): Promise<Response> {
  return createRouteHandlers(await getBridge()).stream(req);
}
