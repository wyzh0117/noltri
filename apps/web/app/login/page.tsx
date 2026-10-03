import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';
import LoginForm from '@/components/LoginForm';
import { resolveAuthStrategy } from '@/lib/auth';
import { readSession } from '@/lib/session';

export default async function LoginPage(): Promise<ReactElement> {
  if ((await readSession()) !== null) redirect('/');
  const strategy = resolveAuthStrategy();
  return (
    <main className="login-page">
      <LoginForm strategy={strategy} />
    </main>
  );
}
