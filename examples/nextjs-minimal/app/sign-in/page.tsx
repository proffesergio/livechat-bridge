'use client';

import { useState } from 'react';

export default function SignInPage() {
  const [name, setName] = useState('Alice Customer');
  const [email, setEmail] = useState('alice@example.com');
  const [isStaff, setIsStaff] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    await fetch('/api/sign-in', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, email, isStaff }),
    });
    window.location.href = isStaff ? '/admin' : '/';
  }

  return (
    <main className="page">
      <h1>Sign in</h1>
      <p>
        This is a throwaway demo session, stored in an HTTP-only cookie. Swap
        it for your real auth (NextAuth, Clerk, Supabase, etc.) by replacing{' '}
        <code>getViewer</code> in <code>app/lib/livechat.ts</code>.
      </p>

      <form className="card" onSubmit={submit}>
        <label htmlFor="name">Name</label>
        <input
          id="name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />

        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />

        <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 16 }}>
          <input
            type="checkbox"
            checked={isStaff}
            onChange={(e) => setIsStaff(e.target.checked)}
          />
          Sign in as staff (gets admin dashboard access)
        </label>

        <button className="btn" type="submit" disabled={busy || !name.trim()}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
