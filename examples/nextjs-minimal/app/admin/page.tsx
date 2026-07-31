import { redirect } from 'next/navigation';
import Link from 'next/link';
import { readServerSession } from '../lib/session';
import { AdminShell } from './admin-shell';

export default function AdminPage() {
  const session = readServerSession();
  if (!session) redirect('/sign-in');
  if (!session.isStaff) {
    return (
      <main className="page">
        <h1>Staff only</h1>
        <p>
          You&rsquo;re signed in as a customer. Sign out and sign back in with the
          &ldquo;staff&rdquo; checkbox to reach the dashboard.
        </p>
        <Link className="btn" href="/">
          Back home
        </Link>
      </main>
    );
  }
  return (
    <div className="admin-shell">
      <div className="admin-bar">
        <span>
          Logged in as <strong>{session.name}</strong> (staff)
        </span>
        <form action="/api/sign-out" method="post">
          <button className="link" type="submit">
            Sign out
          </button>
        </form>
      </div>
      <AdminShell />
    </div>
  );
}
