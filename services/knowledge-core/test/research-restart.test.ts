/**
 * R08（开发文档 §19）：重启／导出恢复后关系完整。
 *
 * 这里不 mock 任何一层：同一份 demo 种子经 `createResearchRepository` 落在真实 SQLite 文件上，
 * 关闭句柄（=进程退出）后重新打开，再把「关系、批准基线、复核标记、出处指针」逐项读回。
 * 第二个用例把 profile 文件整体复制到新路径（=导出/备份恢复）后再读一遍。
 *
 * 桌面 profile 的装配是「同一个 sqliteFile 交给两个工厂、两个句柄」，所以这里也把知识域仓库一起打开，
 * 让双句柄 WAL 布局在往返中被真实走到；关闭时同样关两次。
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createRepository, createResearchRepository, type ResearchRepository } from '@noltri/storage';
import { createResearchDomain, type ResearchDomain } from '../src/research';
import { seedResearchDemo, type ResearchDemoSeed } from '../src/research/demo';

const directories: string[] = [];

function nextFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'noltri-research-restart-'));
  directories.push(dir);
  return path.join(dir, 'noltri.sqlite');
}

afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

interface OpenProfile {
  readonly domain: ResearchDomain;
  readonly research: ResearchRepository;
  close(): Promise<void>;
}

/** The desktop profile layout: one file, both factories, two handles on the same WAL file. */
async function openProfile(file: string): Promise<OpenProfile> {
  const knowledge = await createRepository({ driver: 'sqlite', sqliteFile: file });
  const research = await createResearchRepository({ driver: 'sqlite', sqliteFile: file });
  return {
    domain: createResearchDomain(research),
    research,
    close: async () => {
      // 关两次，同 http/index.ts 的 bundle 关闭顺序：知识域句柄先关，research 句柄后关。
      for (const closable of [knowledge, research] as { close?: () => Promise<void> }[]) {
        if (typeof closable.close === 'function') await closable.close();
      }
    },
  };
}

/** 导出/备份的语义：把库文件整体搬到新路径。WAL 若还在也一起带走，否则重启点会丢在 sidecar 里。 */
function exportProfile(from: string, to: string): void {
  copyFileSync(from, to);
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${from}${suffix}`)) copyFileSync(`${from}${suffix}`, `${to}${suffix}`);
  }
}

const USER = 'user-restart';
const PROVENANCE_TITLE = '带出处指针的访谈证据（测试数据）';

/** 种入 demo 后额外制造三类「往返必须保住」的状态：批准基线、清掉一条标记、一条带指针的证据。 */
async function seedWithBaselineAndMarks(file: string): Promise<ResearchDemoSeed> {
  const profile = await openProfile(file);
  try {
    const seed = await seedResearchDemo(profile.domain, USER);
    await profile.domain.approveCharter(seed.project.id, USER, {
      revisionReason: '演示冻结：基线 v1（测试）',
      affectedEntities: [
        { entityType: 'claim', entityId: seed.claims[0]!.id },
        { entityType: 'evidence', entityId: seed.evidence[0]!.id },
      ],
    });
    const marks = await profile.domain.listReviewMarks(seed.project.id, USER, {});
    const evidenceMark = marks.find((mark) => mark.entityType === 'evidence');
    await profile.domain.clearReviewMark(evidenceMark!.id, USER);
    await profile.domain.createEvidence(seed.project.id, USER, {
      type: 'interview',
      title: PROVENANCE_TITLE,
      nodeId: 'node-42',
      rawSourceId: 'src-42',
      locationOrigin: 'captured',
    });
    return seed;
  } finally {
    await profile.close();
  }
}

function relationKeys(seed: ResearchDemoSeed): string[] {
  return seed.relations
    .map((relation) => `${relation.sourceType}:${relation.sourceId}:${relation.relationType}:${relation.targetType}:${relation.targetId}`)
    .sort();
}

async function expectProfileIntact(file: string, seed: ResearchDemoSeed): Promise<void> {
  const { domain, close } = await openProfile(file);
  try {
    // 项目与章程草稿
    const projects = await domain.listProjects(USER);
    expect(projects.map((project) => project.id)).toEqual([seed.project.id]);
    const charter = await domain.getCharter(seed.project.id, USER);
    expect(charter?.workingTitle).toBe(seed.charter.workingTitle);

    // 批准基线（R06）：整份快照与理由都在，首个基线的 changedFields 仍是空表
    const baseline = await domain.getCharterBaseline(seed.project.id, USER);
    expect(baseline?.version).toBe(1);
    expect(baseline?.previousVersion).toBeNull();
    expect(baseline?.revisionReason).toBe('演示冻结：基线 v1（测试）');
    expect(baseline?.changedFields).toEqual([]);
    expect(await domain.listCharterVersions(seed.project.id, USER)).toHaveLength(1);

    // 复核标记（R03/R06）：清过的仍是 cleared 行，没清的仍是 pending
    const marks = await domain.listReviewMarks(seed.project.id, USER, {});
    expect(marks).toHaveLength(2);
    expect(marks.map((mark) => `${mark.entityType}:${mark.status}`).sort()).toEqual(['claim:pending', 'evidence:cleared']);
    for (const mark of marks) {
      expect(mark.raisedBy).toBe('charter_baseline');
      expect(mark.charterVersion).toBe(1);
    }

    // 关系（R08 的主角）：13 条五元组逐条对上
    const relations = await domain.listRelations(seed.project.id, USER, {});
    expect(
      relations
        .map((relation) => `${relation.sourceType}:${relation.sourceId}:${relation.relationType}:${relation.targetType}:${relation.targetId}`)
        .sort(),
    ).toEqual(relationKeys(seed));

    // 出处指针（R03）：机器读的三个字段原样保留，人读定位没被系统补写
    const evidence = await domain.listEvidence(seed.project.id, USER, {});
    expect(evidence).toHaveLength(6);
    const withProvenance = evidence.find((row) => row.title === PROVENANCE_TITLE);
    expect(withProvenance?.nodeId).toBe('node-42');
    expect(withProvenance?.rawSourceId).toBe('src-42');
    expect(withProvenance?.locationOrigin).toBe('captured');
    expect(withProvenance?.sourceReference).toBeNull();
    expect(withProvenance?.sourceLocation).toBeNull();

    // C-03 仍是 P6 要用的缺口：没有任何指向它的 supports 边
    const thirdClaim = seed.claims[2]!;
    expect(relations.some((relation) => relation.targetId === thirdClaim.id)).toBe(false);

    // 时间线：决策/变更事件与里程碑都还在，且新的在前
    const timeline = await domain.listTimeline(seed.project.id, USER);
    expect(timeline.length).toBeGreaterThanOrEqual(5);
    expect(timeline[0]!.occurredAt >= timeline[timeline.length - 1]!.occurredAt).toBe(true);
  } finally {
    await close();
  }
}

describe('R08：重启与导出恢复后研究数据完整', () => {
  it('关掉两个句柄再开：关系、基线、标记与出处指针逐项读回', async () => {
    const file = nextFile();
    const seed = await seedWithBaselineAndMarks(file);
    await expectProfileIntact(file, seed);
  });

  it('把 profile 文件复制到新路径（导出恢复）后打开：同一批关系完整', async () => {
    const file = nextFile();
    const seed = await seedWithBaselineAndMarks(file);
    const exported = nextFile();
    exportProfile(file, exported);
    await expectProfileIntact(exported, seed);
  });
});
