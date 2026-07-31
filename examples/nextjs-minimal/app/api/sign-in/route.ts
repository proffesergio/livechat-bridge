import { z } from 'zod';
import { buildSessionCookie, type DemoUser } from '../../lib/session';

const schema = z.object({
  name: z.string().min(1).max(60),
  email: z.string().email().optional().or(z.literal('')),
  isStaff: z.boolean().optional(),
});

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return new Response('Bad request', { status: 400 });

  const id = `demo_${parsed.data.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}`;
  const user: DemoUser = {
    id,
    name: parsed.data.name,
    email: parsed.data.email || undefined,
    isStaff: parsed.data.isStaff ?? false,
  };
  return new Response(JSON.stringify({ user }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'set-cookie': buildSessionCookie(user),
    },
  });
}
