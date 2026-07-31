import Link from 'next/link';
import { readServerSession } from './lib/session';
import { ChatWidget } from './chat-widget';

export default function HomePage() {
  const session = readServerSession();
  return (
    <main className="page">
      <h1>livechat-bridge demo</h1>
      <p>
        A self-contained Next.js app exercising the widget, admin dashboard,
        SSE realtime transport, in-memory storage, and the 30-second AI
        fallback — all with no external SaaS.
      </p>

      <div className="card">
        {session ? (
          <>
            <p>
              Signed in as <strong>{session.name}</strong>
              {session.isStaff ? ' (staff)' : ' (customer)'}.
            </p>
            <div className="row">
              {session.isStaff ? (
                <Link className="btn" href="/admin">
                  Open admin dashboard
                </Link>
              ) : null}
              <form action="/api/sign-out" method="post">
                <button className="btn secondary" type="submit">
                  Sign out
                </button>
              </form>
            </div>
          </>
        ) : (
          <>
            <p>You&rsquo;re browsing as a guest. Sign in to send a message.</p>
            <Link className="btn" href="/sign-in">
              Sign in
            </Link>
          </>
        )}
      </div>

      <div className="card">
        <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>Try it</h2>
        <ol style={{ margin: 0, paddingLeft: 18, color: 'var(--page-muted)', lineHeight: 1.6 }}>
          <li>
            Open this page in two windows. In one, sign in as a customer; in
            the other, sign in as staff.
          </li>
          <li>
            From the customer window, open the chat bubble and send a message.
            Watch it appear in the staff dashboard in real time.
          </li>
          <li>
            Wait without claiming — the AI assistant steps in after the
            fallback window (default 30 s, override with <code>AI_FALLBACK_MS</code>).
          </li>
          <li>
            Claim from the staff side. The customer sees a &ldquo;staff joined&rdquo; system
            message, and any later staff message takes over silently.
          </li>
        </ol>
      </div>

      <ChatWidget />
    </main>
  );
}
