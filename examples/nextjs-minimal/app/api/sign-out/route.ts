import { buildClearCookie } from '../../lib/session';

export async function POST(): Promise<Response> {
  return new Response(null, {
    status: 303,
    headers: {
      location: '/',
      'set-cookie': buildClearCookie(),
    },
  });
}
