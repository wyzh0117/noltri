import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';
import Workbench from '@/components/Workbench';
import { readSession } from '@/lib/session';

/**
 * First screen is the knowledge tree (PROJECT_MASTER §2.1); the Research workbench is reachable from
 * its Project Type switch. Without a session the workbench is replaced by the login page; nothing is
 * reachable anonymously.
 */
export default async function Page(): Promise<ReactElement> {
  const session = await readSession();
  if (!session) redirect('/login');
  return <Workbench strategy={session.strategy} />;
}
