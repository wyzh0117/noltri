import type { ReactElement } from 'react';
import { redirect } from 'next/navigation';
import Workspace from '@/components/Workspace';
import { readSession } from '@/lib/session';

/**
 * First screen is the knowledge tree (PROJECT_MASTER §2.1). Without a session the workspace is
 * replaced by the login page; nothing about the tree is reachable anonymously.
 */
export default async function Page(): Promise<ReactElement> {
  const session = await readSession();
  if (!session) redirect('/login');
  return <Workspace strategy={session.strategy} />;
}
