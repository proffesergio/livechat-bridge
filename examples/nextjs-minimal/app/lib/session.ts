import { cookies } from 'next/headers';

export interface DemoUser {
  id: string;
  name: string;
  email?: string;
  isStaff: boolean;
}

const COOKIE = 'lcb_demo_user';

/** Decode the demo session cookie from a raw `Request`. */
export function readSession(req: Request): DemoUser | null {
  const header = req.headers.get('cookie') ?? '';
  const match = header.split(';').map((p) => p.trim()).find((p) => p.startsWith(`${COOKIE}=`));
  if (!match) return null;
  const raw = decodeURIComponent(match.slice(COOKIE.length + 1));
  try {
    const parsed = JSON.parse(raw) as DemoUser;
    if (!parsed?.id || !parsed?.name) return null;
    return { ...parsed, isStaff: Boolean(parsed.isStaff) };
  } catch {
    return null;
  }
}

/** Read the session from the Next.js server cookies API (for server components). */
export function readServerSession(): DemoUser | null {
  const raw = cookies().get(COOKIE)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DemoUser;
    if (!parsed?.id || !parsed?.name) return null;
    return { ...parsed, isStaff: Boolean(parsed.isStaff) };
  } catch {
    return null;
  }
}

/** Build the `Set-Cookie` header value for the demo session. */
export function buildSessionCookie(user: DemoUser): string {
  const value = encodeURIComponent(JSON.stringify(user));
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
}

export function buildClearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
