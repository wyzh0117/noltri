'use client';

import { useState } from 'react';
import type { FormEvent, ReactElement } from 'react';
import {
  publishServerSession,
  readAccessToken,
  signInWithEmail,
  startOAuthSignIn,
  type OAuthProvider,
} from '@/lib/auth';
import type { SessionStrategy } from '@/lib/cookie';

export interface LoginFormProps {
  strategy: SessionStrategy;
}

/**
 * Exactly one login surface is rendered, decided by the server from the environment. A Supabase
 * session is never simulated locally, and the local path is labelled as development-only on the card
 * itself as well as in the app-wide banner.
 */
export default function LoginForm({ strategy }: LoginFormProps): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (strategy === 'dev-token') {
    return <DevTokenCard />;
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '');
    const password = String(form.get('password') ?? '');
    setBusy(true);
    setError(null);
    const signedIn = await signInWithEmail(email, password);
    if (signedIn.error) {
      setError(signedIn.error);
      setBusy(false);
      return;
    }
    const token = await readAccessToken();
    if (token === null) {
      setError('未能取得访问令牌。');
      setBusy(false);
      return;
    }
    const published = await publishServerSession(token);
    setBusy(false);
    if (published.error) {
      setError(published.error);
      return;
    }
    window.location.replace('/');
  }

  async function oauth(provider: OAuthProvider): Promise<void> {
    setBusy(true);
    setError(null);
    const outcome = await startOAuthSignIn(provider);
    setBusy(false);
    if (outcome.error) setError(outcome.error);
  }

  return (
    <div className="login-card">
      <div className="login-brand">知序</div>
      <p className="login-sub">登录后可围绕知识树继续整理与讨论。</p>

      <form className="login-form" onSubmit={(event) => void submit(event)}>
        <label className="login-label" htmlFor="email">
          邮箱
        </label>
        <input id="email" name="email" className="field-input" type="email" autoComplete="email" required />
        <label className="login-label" htmlFor="password">
          密码
        </label>
        <input id="password" name="password" className="field-input" type="password" autoComplete="current-password" required />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? '正在登录…' : '登录'}
        </button>
      </form>

      <div className="login-divider">或</div>

      <div className="login-form">
        <button type="button" className="btn" disabled={busy} onClick={() => void oauth('google')}>
          使用 Google 继续
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void oauth('github')}>
          使用 GitHub 继续
        </button>
      </div>

      {error !== null ? <p className="error-note">{error}</p> : null}
    </div>
  );
}

function DevTokenCard(): ReactElement {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    setWarning(null);
    try {
      const response = await fetch('/api/web/auth/dev-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; warning?: string; error?: { message?: string } }
        | null;
      if (!response.ok || payload?.ok !== true) {
        setError(payload?.error?.message ?? `登录失败（${response.status}）。`);
        return;
      }
      if (payload.warning) setWarning(payload.warning);
      window.location.replace('/');
    } catch {
      setError('无法连接登录接口。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-card">
      <div className="login-brand">知序</div>
      <p className="login-sub">个人知识编译系统 · 知识树</p>

      <div className="dev-card">
        <p className="dev-card-title">本地开发登录</p>
        <p className="dev-card-body">
          当前为本地开发登录，未接入 Supabase Auth。填入知识服务的 NOLTRI_DEV_TOKEN；若服务端
          NOLTRI_DEV_REQUIRE_TOKEN=false，可留空直接进入。此方式只用于本机开发，不是正式账号体系。
        </p>
        <div className="login-form">
          <label className="login-label" htmlFor="dev-token">
            开发令牌（可留空）
          </label>
          <input
            id="dev-token"
            className="field-input"
            type="password"
            value={token}
            autoComplete="off"
            onChange={(event) => setToken(event.target.value)}
          />
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
            {busy ? '正在验证…' : '进入知识树'}
          </button>
        </div>
        {error !== null ? <p className="error-note">{error}</p> : null}
        {warning !== null ? <p className="muted-note">{warning}</p> : null}
      </div>
    </div>
  );
}
