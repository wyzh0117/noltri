'use client';

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import Link from 'next/link';
import { completeOAuthCallback, publishServerSession } from '@/lib/auth';

/**
 * Landing page for the Supabase PKCE redirect: exchanges the code for a session, then hands the access
 * token to /api/web/auth/session so the server can hold the core bearer in an httpOnly cookie.
 */
export default function AuthCallbackPage(): ReactElement {
  const [status, setStatus] = useState('正在完成授权…');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const code = readCode();
      if (code === null) {
        setStatus('授权回调缺少 code，请重新登录。');
        return;
      }
      const exchanged = await completeOAuthCallback(code);
      if (cancelled) return;
      if (exchanged.token === null) {
        setStatus(exchanged.error ?? '授权失败。');
        return;
      }
      const published = await publishServerSession(exchanged.token);
      if (cancelled) return;
      if (published.error) {
        setStatus(published.error);
        return;
      }
      window.location.replace('/');
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="login-page">
      <div className="login-card">
        <div className="login-brand">知序</div>
        <p className="login-sub">{status}</p>
        <Link href="/login">返回登录</Link>
      </div>
    </main>
  );
}

function readCode(): string | null {
  const query = new URLSearchParams(window.location.search).get('code');
  if (query) return query;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('code');
  return hash;
}
