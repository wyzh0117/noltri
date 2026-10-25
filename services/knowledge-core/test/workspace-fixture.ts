import { createInMemoryRepository } from '@noltri/storage';
import { createSqliteRepository } from '../../../packages/storage/src/sqlite';
import { createOfflineProvider } from '@noltri/ai-provider';
import { silentLogger } from '@noltri/shared';
import type { CoreDeps } from '../src/types';
import { testConfig } from './fakes';
import { getCourseDocument, applyCourseDocumentPatch, loadWorkspace, getLegacyCourseNote, saveLegacyCourseNote } from '../src/services/course-workspace';

export async function workspaceFixture(driver: 'memory' | 'sqlite' = 'memory') {
  const repository = driver === 'memory' ? createInMemoryRepository() : await createSqliteRepository({ file: ':memory:' });
  const deps: CoreDeps = { repository, provider: createOfflineProvider(), config: testConfig(), logger: silentLogger };
  const actor = { userId: 'u', actor: 'test' };
  const a = await repository.createNode({ userId: 'u', title: 'Python', nodeType: 'topic' });
  const b = await repository.createNode({ userId: 'u', title: 'Java', nodeType: 'topic' });
  const c = await repository.createNode({ userId: 'u', title: 'References', nodeType: 'topic' });
  const shared = await repository.createNode({ userId: 'u', title: 'Variables', nodeType: 'chapter' });
  for (const node of [a, b]) await repository.createEdge({ userId: 'u', fromNodeId: shared.id, toNodeId: node.id, relationType: 'part_of', source: 'topic_chapter' });
  return { repository, deps, actor, a, b, c, shared };
}
