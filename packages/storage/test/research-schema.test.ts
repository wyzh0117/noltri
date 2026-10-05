/**
 * What the shared contract cannot see about the research half: what the file actually contains, whether
 * the version-3 DDL still agrees with the zod enums, and what the constraints refuse.
 *
 * The enum comparison mirrors `migrations.test.ts` for Postgres, with one difference that matters: the
 * archived Postgres research migrations were deliberately not ported, so `packages/schema/src/research.ts`
 * is the only source of truth these CHECK clauses can be checked against.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import {
  claimStatusSchema,
  claimTypeSchema,
  driftFindingStatusSchema,
  driftSeveritySchema,
  driftTypeSchema,
  evidenceTypeSchema,
  researchChangeTypeSchema,
  researchEntityTypeSchema,
  researchProjectStatusSchema,
  researchQuestionStatusSchema,
  researchRelationTypeSchema,
  timelineEventTypeSchema,
  timelineSourceSchema,
} from '@noltri/schema';
import { SQLITE_DDL_V3, SQLITE_MIGRATIONS, SQLITE_SCHEMA_VERSION, openSqlite } from '../src/sqlite-schema';
import { SqliteRepository } from '../src/sqlite';
import { SqliteResearchRepository } from '../src/sqlite-research';
import { createRepository, createResearchRepository } from '../src/index';

const directories: string[] = [];

function nextFile(name = 'research.sqlite'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'noltri-research-'));
  directories.push(dir);
  return path.join(dir, name);
}

afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

const STAMP = '2026-10-06T00:00:00.000Z';

/** The slice of a zod enum this file needs, kept structural so every enum fits. */
interface EnumLike {
  readonly options: readonly string[];
  safeParse(data: unknown): { success: boolean };
}

/** Every research column that carries an enum: its CHECK labels and the zod enum must agree exactly. */
const ENUM_COLUMNS: ReadonlyArray<{ table: string; column: string; schema: EnumLike }> = [
  { table: 'research_projects', column: 'status', schema: researchProjectStatusSchema },
  { table: 'research_questions', column: 'status', schema: researchQuestionStatusSchema },
  { table: 'research_evidence', column: 'type', schema: evidenceTypeSchema },
  { table: 'research_claims', column: 'claim_type', schema: claimTypeSchema },
  { table: 'research_claims', column: 'status', schema: claimStatusSchema },
  { table: 'research_entity_relations', column: 'source_type', schema: researchEntityTypeSchema },
  { table: 'research_entity_relations', column: 'target_type', schema: researchEntityTypeSchema },
  { table: 'research_entity_relations', column: 'relation_type', schema: researchRelationTypeSchema },
  { table: 'research_changes', column: 'change_type', schema: researchChangeTypeSchema },
  { table: 'research_drift_findings', column: 'drift_type', schema: driftTypeSchema },
  { table: 'research_drift_findings', column: 'severity', schema: driftSeveritySchema },
  { table: 'research_drift_findings', column: 'status', schema: driftFindingStatusSchema },
  { table: 'research_drift_findings', column: 'source_entity_type', schema: researchEntityTypeSchema },
  { table: 'research_drift_findings', column: 'target_entity_type', schema: researchEntityTypeSchema },
  { table: 'research_timeline_events', column: 'event_type', schema: timelineEventTypeSchema },
  { table: 'research_timeline_events', column: 'source_type', schema: timelineSourceSchema },
];

const RESEARCH_TABLES = [
  'research_charters',
  'research_claims',
  'research_changes',
  'research_decisions',
  'research_drift_findings',
  'research_entity_relations',
  'research_evidence',
  'research_manuscript_sections',
  'research_projects',
  'research_questions',
  'research_timeline_events',
] as const;

function checkLabels(table: string, column: string): string[] {
  // A nullable column guards with `… is null or … in (…)`; both shapes must be readable here.
  const pattern = new RegExp(
    `constraint ${table}_${column}_enum_check\\s+check\\s*\\(\\s*` +
      `(?:${column}\\s+is\\s+null\\s+or\\s+)?${column}\\s+in\\s*\\(([^)]*)\\)`,
    'i',
  );
  const found = pattern.exec(SQLITE_DDL_V3);
  const list = found?.[1];
  if (list === undefined) {
    throw new Error(`${table}.${column} has no ${table}_${column}_enum_check CHECK clause in DDL_V3`);
  }
  return [...list.matchAll(/'([^']*)'/g)].map((match) => match[1] ?? '').sort();
}

describe('the version 3 DDL', () => {
  it('creates the eleven research tables in the file', () => {
    const { db, pragmas } = openSqlite({ file: nextFile() });
    expect(pragmas.schemaVersion).toBe(SQLITE_SCHEMA_VERSION);
    const tables = db
      .prepare("select name from sqlite_master where type = 'table' and name like 'research_%' order by name")
      .all()
      .map((row) => String(row.name));
    expect(tables).toEqual([...RESEARCH_TABLES].sort());
    db.close();
  });

  it('keeps every research enum CHECK label in sync with the zod enums, in both directions', () => {
    for (const { table, column, schema } of ENUM_COLUMNS) {
      const sqlLabels = checkLabels(table, column);
      const expected = [...schema.options].sort();
      for (const label of expected) {
        expect(sqlLabels, `${table}.${column} is missing the zod label "${label}"`).toContain(label);
      }
      for (const label of sqlLabels) {
        expect(expected, `${table}.${column} carries the undeclared label "${label}"`).toContain(label);
        expect(schema.safeParse(label).success, `${label} no longer parses`).toBe(true);
      }
      expect(sqlLabels, `${table}.${column} labels drifted from zod`).toEqual(expected);
    }
  });

  it('holds one charter per project and one row per relation tuple', () => {
    const { db } = openSqlite({ file: nextFile() });
    db.prepare(
      `insert into research_projects (id, user_id, name, created_at, updated_at)
       values ('p', 'u', '冷链研究', ?, ?)`,
    ).run(STAMP, STAMP);
    const charter = db.prepare(
      `insert into research_charters (id, project_id, user_id, working_title, created_at, updated_at)
       values (?, 'p', 'u', ?, ?, ?)`,
    );
    charter.run('c1', '第一版', STAMP, STAMP);
    expect(() => charter.run('c2', '第二版', STAMP, STAMP)).toThrow(/UNIQUE/i);

    const relation = db.prepare(
      `insert into research_entity_relations
        (id, project_id, user_id, source_type, source_id, relation_type, target_type, target_id, note, created_at)
       values (?, 'p', 'u', 'evidence', ?, 'supports', 'claim', ?, ?, ?)`,
    );
    relation.run('r1', 'e1', 'k1', '第一段说明', STAMP);
    // The stored note survives a replay attempt; the tuple is what makes the row unique.
    expect(() => relation.run('r2', 'e1', 'k1', '第二段说明', STAMP)).toThrow(/UNIQUE/i);
    expect(() => relation.run('r3', 'e1', 'k2', '另一个结论', STAMP)).not.toThrow();
    db.close();
  });

  it('refuses an enum value the domain does not define', () => {
    const { db } = openSqlite({ file: nextFile() });
    db.prepare(
      `insert into research_projects (id, user_id, name, created_at, updated_at)
       values ('p', 'u', '冷链研究', ?, ?)`,
    ).run(STAMP, STAMP);
    expect(() =>
      db
        .prepare(
          `insert into research_claims (id, project_id, user_id, claim_code, claim_text, claim_type,
            status, created_at, updated_at)
           values ('k', 'p', 'u', 'C-1', 'x', 'speculative', 'draft', ?, ?)`,
        )
        .run(STAMP, STAMP),
    ).toThrow(/CHECK constraint/i);
    expect(() =>
      db
        .prepare(
          `insert into research_evidence (id, project_id, user_id, type, title, created_at, updated_at)
           values ('e', 'p', 'u', 'rumour', 'x', ?, ?)`,
        )
        .run(STAMP, STAMP),
    ).toThrow(/CHECK constraint/i);
    // A confidence the schema would reject never reaches a row either.
    expect(() =>
      db
        .prepare(
          `insert into research_claims (id, project_id, user_id, claim_code, claim_text, claim_type,
            status, confidence, created_at, updated_at)
           values ('k2', 'p', 'u', 'C-2', 'x', 'descriptive', 'draft', 1.4, ?, ?)`,
        )
        .run(STAMP, STAMP),
    ).toThrow(/CHECK constraint/i);
    db.close();
  });

  it('cascades a project delete to every research row but never touches the knowledge tables', () => {
    const { db } = openSqlite({ file: nextFile() });
    db.prepare(
      `insert into research_projects (id, user_id, name, created_at, updated_at)
       values ('p', 'u', '冷链研究', ?, ?)`,
    ).run(STAMP, STAMP);
    db.prepare(
      `insert into research_questions (id, project_id, user_id, question_code, question_text, created_at, updated_at)
       values ('q', 'p', 'u', 'RQ1', 'x', ?, ?)`,
    ).run(STAMP, STAMP);
    db.prepare(
      `insert into research_timeline_events (id, project_id, user_id, event_type, occurred_at, title, created_at)
       values ('t', 'p', 'u', 'milestone', ?, '开工', ?)`,
    ).run(STAMP, STAMP);
    db.prepare(
      `insert into knowledge_nodes (id, user_id, title, created_at, updated_at) values ('n', 'u', '节点', ?, ?)`,
    ).run(STAMP, STAMP);

    db.prepare("delete from research_projects where id = 'p'").run();
    expect(db.prepare("select count(*) as n from research_questions where project_id = 'p'").get()).toMatchObject({
      n: 0,
    });
    expect(db.prepare("select count(*) as n from research_timeline_events").get()).toMatchObject({ n: 0 });
    // The knowledge half has no such relationship: a research project owns no knowledge rows.
    expect(db.prepare("select count(*) as n from knowledge_nodes").get()).toMatchObject({ n: 1 });
    db.close();
  });
});

describe('a version 2 profile upgrades in place', () => {
  /** Exactly what an installed app leaves behind: knowledge rows, `user_version = 2`, no research tables. */
  function seededV2(file: string): void {
    const db = new DatabaseSync(file);
    db.exec('pragma journal_mode = wal');
    for (const step of SQLITE_MIGRATIONS.filter((entry) => entry.version < 3)) step.apply(db);
    db.exec('pragma user_version = 2');
    db
      .prepare(
        `insert into raw_sources (id, user_id, raw_text, source_type, captured_at, created_at, metadata_json)
         values ('old-1', 'u', '升级前写入的原文', 'manual', ?, ?, '{}')`,
      )
      .run(STAMP, STAMP);
    db.close();
  }

  it('keeps the capture it already had and adds the research tables', async () => {
    const file = nextFile('upgrade.sqlite');
    seededV2(file);

    const knowledge = new SqliteRepository({ file });
    expect(knowledge.schemaInfo.schemaVersion).toBe(SQLITE_SCHEMA_VERSION);
    expect((await knowledge.findRawSource('old-1', 'u'))?.rawText).toBe('升级前写入的原文');
    const research = new SqliteResearchRepository({ file });
    const project = await research.createResearchProject({ userId: 'u', name: '  冷链物流服务质量研究  ' });
    expect(project.name).toBe('冷链物流服务质量研究');
    await research.close();
    await knowledge.close();

    // Reopening must not try to apply version 3 a second time.
    const again = new SqliteResearchRepository({ file });
    const listed = await again.listResearchProjects('u');
    expect(listed.map((row) => row.id)).toEqual([project.id]);
    expect(again.storageStatus().schemaVersion).toBe(SQLITE_SCHEMA_VERSION);
    await again.close();
  });

  it('serves the knowledge and research halves from one profile file', async () => {
    const file = nextFile('shared.sqlite');
    const knowledge = new SqliteRepository({ file });
    const research = new SqliteResearchRepository({ file });
    const source = await knowledge.createRawSource({
      userId: 'u',
      rawText: 'ISM 结构建模的访谈记录',
      sourceType: 'manual',
      capturedAt: STAMP,
      metadata: {},
    });
    const project = await research.createResearchProject({ userId: 'u', name: '冷链研究' });
    await research.createResearchQuestion({
      userId: 'u',
      projectId: project.id,
      questionCode: 'RQ1',
      questionText: '因素如何组织？',
    });

    expect((await knowledge.findRawSource(source.id, 'u'))?.id).toBe(source.id);
    expect((await research.listResearchQuestions(project.id, 'u')).map((row) => row.questionCode)).toEqual(['RQ1']);
    // One file, one schema version: both handles agree on what the profile is.
    expect(knowledge.storageHealth().detail.schemaVersion).toBe(research.storageStatus().schemaVersion);
    expect(knowledge.storageHealth().ok).toBe(true);
    await research.close();
    await knowledge.close();
  });
});

describe('the research driver is chosen in one place', () => {
  it('hands back the driver the caller named', async () => {
    expect((await createResearchRepository({ driver: 'memory' })).driver).toBe('memory');
    const file = nextFile('factory.sqlite');
    const repository = await createResearchRepository({ driver: 'sqlite', sqliteFile: file });
    expect(repository.driver).toBe('sqlite');
    const project = await repository.createResearchProject({ userId: 'u', name: '工厂测试' });
    expect((await repository.listResearchProjects('u')).map((row) => row.id)).toEqual([project.id]);
    // `close()` is a driver capability, not a contract method: the same reflective check the suite uses.
    const close = Reflect.get(repository, 'close');
    if (typeof close === 'function') await (close as () => Promise<void>).call(repository);
  });

  it('refuses a sqlite file it was not given and a supabase driver it does not have', async () => {
    await expect(createResearchRepository({ driver: 'sqlite' })).rejects.toThrow(/sqliteFile/);
    await expect(createResearchRepository({ driver: 'supabase' })).rejects.toThrow(/supabase/);
    // A driver name outside the union is what a mis-typed config produces; the factory says so out loud.
    await expect(createResearchRepository({ driver: 'postgres' as never })).rejects.toThrow(
      /Unknown storage driver/,
    );
  });

  it('leaves the knowledge factory alone: research never changes how a driver is picked for it', async () => {
    expect((await createRepository({ driver: 'memory' })).driver).toBe('memory');
    await expect(createRepository({ driver: 'sqlite' })).rejects.toThrow(/sqliteFile/);
  });
});
