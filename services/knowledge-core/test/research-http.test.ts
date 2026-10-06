/**
 * Research HTTP contract (research contract §1) through the shared router — the same `handle` that
 * node:http mounts and the WebView talks to. Responses are parsed with the frozen schemas so the wire
 * shape holds in both directions.
 *
 * Two things here are about this branch rather than the archived cloud build: research reaches the router
 * only through `core.research` (`deps.research` exists for one job — marking 引用 when a knowledge node is
 * archived, see `research-archive.test.ts`), and a 本地客户端授权 grant is refused before it gets here — see
 * the granted-client case.
 */
import { describe, expect, it } from 'vitest';
import { createOfflineProvider } from '@noltri/ai-provider';
import {
  apiErrorSchema,
  charterBaselineResponseSchema,
  charterResponseSchema,
  charterVersionListResponseSchema,
  charterVersionSchema,
  claimSchema,
  driftCheckResponseSchema,
  driftFindingListResponseSchema,
  driftFindingSchema,
  evidenceSchema,
  researchContextPackResponseSchema,
  researchMapResponseSchema,
  researchProjectListResponseSchema,
  researchProjectSchema,
  researchQuestionListResponseSchema,
  researchQuestionSchema,
  researchReferenceResponseSchema,
  researchReviewMarkSchema,
  reviewMarkListResponseSchema,
} from '@noltri/schema';
import { silentLogger } from '@noltri/shared';
import { createInMemoryRepository } from '@noltri/storage';
import { resolveIdentity } from '../src/auth';
import { InMemoryGrantStore, createGrantResolver, issueGrant, type GrantStore } from '../src/authorization';
import { createKnowledgeCore } from '../src/core';
import { createResearchDomain, type ResearchDomain } from '../src/research';
import { createRequestHandler, type RequestHandler } from '../src/http/router';
import { FakeResearchRepository } from './research-fakes';
import { testConfig } from './fakes';

function coreOf(research: ResearchDomain | undefined) {
  const config = testConfig();
  const core = createKnowledgeCore({
    repository: createInMemoryRepository(),
    provider: createOfflineProvider({ embeddingDim: 1536 }),
    config,
    logger: silentLogger,
    ...(research === undefined ? {} : { research }),
  });
  return { config, core };
}

function handlerOf(options: { research?: ResearchDomain; grants?: GrantStore } = {}): RequestHandler {
  const { config, core } = coreOf(options.research ?? createResearchDomain(new FakeResearchRepository()));
  const store = options.grants;
  return createRequestHandler({
    core,
    config,
    ...(store === undefined ? {} : { grants: store }),
    ...(store === undefined
      ? {}
      : { identityResolver: createGrantResolver(store, (request, cfg) => resolveIdentity(request, cfg)) }),
  });
}

async function jsonOf(response: Response): Promise<unknown> {
  return (await response.json()) as unknown;
}

async function call(
  handle: RequestHandler,
  method: string,
  path: string,
  body?: unknown,
  secret?: string,
): Promise<Response> {
  return handle(
    new Request(`http://core.local${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-noltri-client': 'desktop',
        ...(secret === undefined ? {} : { authorization: `Bearer ${secret}` }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function newProject(handle: RequestHandler, name = 'P'): Promise<string> {
  const created = await call(handle, 'POST', '/api/research/projects', { name });
  return researchProjectSchema.parse(await jsonOf(created)).id;
}

describe('research http routes', () => {
  it('creates and lists projects over the wire with the frozen schemas', async () => {
    const handle = handlerOf();
    const created = await call(handle, 'POST', '/api/research/projects', { name: '碳定价研究' });
    expect(created.status).toBe(200);
    expect(researchProjectSchema.parse(await jsonOf(created)).name).toBe('碳定价研究');

    const list = await call(handle, 'GET', '/api/research/projects');
    expect(researchProjectListResponseSchema.parse(await jsonOf(list)).projects).toHaveLength(1);
  });

  it('serves the charter pair, including the null charter for a fresh project', async () => {
    const handle = handlerOf();
    const projectId = await newProject(handle);

    const empty = charterResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', `/api/research/projects/${projectId}/charter`)),
    );
    expect(empty.charter).toBeNull();

    const saved = await call(handle, 'PUT', `/api/research/projects/${projectId}/charter`, {
      workingTitle: '碳定价与工业排放',
      coreContribution: '大样本因果估计',
    });
    expect(saved.status).toBe(200);
    const charter = charterResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', `/api/research/projects/${projectId}/charter`)),
    );
    expect(charter.charter?.workingTitle).toBe('碳定价与工业排放');
  });

  it('runs the questions row: create, list, patch', async () => {
    const handle = handlerOf();
    const projectId = await newProject(handle);
    const question = researchQuestionSchema.parse(
      await jsonOf(
        await call(handle, 'POST', `/api/research/projects/${projectId}/questions`, {
          questionCode: 'RQ1',
          questionText: '碳定价是否降低排放？',
        }),
      ),
    );
    const patched = researchQuestionSchema.parse(
      await jsonOf(await call(handle, 'PATCH', `/api/research/questions/${question.id}`, { status: 'answered' })),
    );
    expect(patched.status).toBe('answered');
    const list = researchQuestionListResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', `/api/research/projects/${projectId}/questions`)),
    );
    expect(list.questions).toHaveLength(1);
  });

  it('deletes relations and reports {deleted,id}', async () => {
    const handle = handlerOf();
    const projectId = await newProject(handle);
    const question = researchQuestionSchema.parse(
      await jsonOf(
        await call(handle, 'POST', `/api/research/projects/${projectId}/questions`, {
          questionCode: 'RQ1',
          questionText: 'q',
        }),
      ),
    );
    await call(handle, 'POST', `/api/research/projects/${projectId}/claims`, {
      claimCode: 'C1',
      claimText: 'x',
      claimType: 'empirical',
    });
    const claims = (await jsonOf(await call(handle, 'GET', `/api/research/projects/${projectId}/claims`))) as {
      claims: { id: string }[];
    };
    const created = (await jsonOf(
      await call(handle, 'POST', `/api/research/projects/${projectId}/relations`, {
        sourceType: 'claim',
        sourceId: claims.claims[0]!.id,
        relationType: 'answers',
        targetType: 'research_question',
        targetId: question.id,
      }),
    )) as { id: string };

    const deleted = await call(handle, 'DELETE', `/api/research/relations/${created.id}`);
    expect(deleted.status).toBe(200);
    expect(await jsonOf(deleted)).toEqual({ deleted: true, id: created.id });
  });

  it('wraps failures in the shared error envelope', async () => {
    const handle = handlerOf();
    const invalid = await call(handle, 'POST', '/api/research/projects', { name: '' });
    expect(invalid.status).toBe(400);
    expect(apiErrorSchema.parse(await jsonOf(invalid)).error.code).toBe('invalid_request');

    const missing = await call(handle, 'GET', '/api/research/projects/nope/questions');
    expect(missing.status).toBe(404);
    expect(apiErrorSchema.parse(await jsonOf(missing)).error.code).toBe('not_found');
  });

  /**
   * The route table is what says which verb a research path takes, so a wrong verb must be a 405 from the
   * router rather than a silently-accepted fall-through in `handleResearch`'s write branches.
   */
  it('answers a verb the route table does not list with 405', async () => {
    const handle = handlerOf();
    const response = await call(handle, 'DELETE', '/api/research/projects');
    expect(response.status).toBe(405);
    expect(apiErrorSchema.parse(await jsonOf(response)).error.code).toBe('invalid_request');
  });

  /**
   * Research is closed to Agent clients until its text goes through 限制返回片段 (contract §4). The refusal
   * has to come from the scope table, not from a check inside the research handler — so the same handler
   * still serves the desktop credential on the very next request.
   */
  it('refuses a granted client on the research paths and still serves the device credential', async () => {
    const store = new InMemoryGrantStore();
    const { secret } = await issueGrant(store, { label: '想读研究的 Agent', scopes: ['read', 'mutate'] });
    const handle = handlerOf({ grants: store });

    for (const [method, path] of [
      ['GET', '/api/research/projects'],
      ['POST', '/api/research/projects'],
      ['GET', '/api/research/projects/whatever/questions'],
      ['DELETE', '/api/research/relations/whatever'],
      // P5-C 的批准与标记同样不向 grant 开放：文本还没走 `capText`。
      ['POST', '/api/research/projects/whatever/charter/approve'],
      ['GET', '/api/research/projects/whatever/charter/versions'],
      ['GET', '/api/research/projects/whatever/charter/baseline'],
      ['GET', '/api/research/projects/whatever/review-marks'],
      ['POST', '/api/research/review-marks/whatever/clear'],
      ['GET', '/api/research/references?nodeId=whatever'],
    ] as const) {
      const response = await call(
        handle,
        method,
        path,
        method === 'POST' ? { name: '不该被创建' } : undefined,
        secret,
      );
      const body = apiErrorSchema.parse(await jsonOf(response)).error;
      expect(response.status).toBe(401);
      expect(body.code).toBe('unauthorized');
      expect((body.details as { reason?: string }).reason).toBe('route_not_granted');
    }

    // The same handler still serves 工作台: it is the credential kind that decides, not the route.
    expect((await call(handle, 'POST', '/api/research/projects', { name: '工作台项目' })).status).toBe(200);
  });

  it('reports research_not_wired instead of pretending an empty library', async () => {
    const { config, core } = coreOf(undefined);
    const handle = createRequestHandler({ core, config });
    const response = await call(handle, 'GET', '/api/research/projects');
    expect(response.status).toBe(500);
    const body = apiErrorSchema.parse(await jsonOf(response)).error;
    expect(body.code).toBe('internal_error');
    expect((body.details as { reason?: string }).reason).toBe('research_not_wired');
  });
});

/**
 * P5-C 的五条新路由（R06 批准基线 + R03/R06 复核标记）。Parsed with the frozen response schemas, so a
 * renamed wrapper key fails here rather than in the workbench.
 */
describe('the approved baseline and review mark routes', () => {
  it('approves, lists, reads the baseline, then marks and clears over the wire', async () => {
    const handle = handlerOf();
    const projectId = await newProject(handle);
    await call(handle, 'PUT', `/api/research/projects/${projectId}/charter`, {
      workingTitle: '碳定价与工业排放',
      researchMethod: 'DID',
    });
    const question = researchQuestionSchema.parse(
      await jsonOf(
        await call(handle, 'POST', `/api/research/projects/${projectId}/questions`, {
          questionCode: 'RQ1',
          questionText: '碳定价是否降低排放？',
        }),
      ),
    );

    const approved = charterVersionSchema.parse(
      await jsonOf(
        await call(handle, 'POST', `/api/research/projects/${projectId}/charter/approve`, {
          revisionReason: '开题时批准的基线',
          affectedEntities: [{ entityType: 'research_question', entityId: question.id }],
        }),
      ),
    );
    expect(approved.version).toBe(1);
    expect(approved.previousVersion).toBeNull();
    expect(approved.changedFields).toEqual([]);

    const versions = charterVersionListResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', `/api/research/projects/${projectId}/charter/versions`)),
    );
    expect(versions.versions.map((row) => row.version)).toEqual([1]);

    const baseline = charterBaselineResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', `/api/research/projects/${projectId}/charter/baseline`)),
    );
    expect(baseline.baseline?.id).toBe(approved.id);
    expect(baseline.baseline?.charter.workingTitle).toBe('碳定价与工业排放');

    const marked = reviewMarkListResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', `/api/research/projects/${projectId}/review-marks`)),
    );
    expect(marked.marks.map((mark) => mark.entityId)).toEqual([question.id]);
    expect(marked.marks[0]?.raisedBy).toBe('charter_baseline');
    expect(marked.marks[0]?.status).toBe('pending');

    // 处理完只改状态：清空之后整条列表仍读得到这一行（开发文档 §14）。
    const cleared = researchReviewMarkSchema.parse(
      await jsonOf(await call(handle, 'POST', `/api/research/review-marks/${marked.marks[0]!.id}/clear`)),
    );
    expect(cleared.status).toBe('cleared');
    const pending = reviewMarkListResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', `/api/research/projects/${projectId}/review-marks?status=pending`)),
    );
    expect(pending.marks).toEqual([]);
    const stillThere = reviewMarkListResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', `/api/research/projects/${projectId}/review-marks`)),
    );
    expect(stillThere.marks).toHaveLength(1);

    // 第二次批准：新的版本号，改动的字段名，基线随之换绑。
    await call(handle, 'PUT', `/api/research/projects/${projectId}/charter`, {
      workingTitle: '碳定价与工业排放',
      researchMethod: '合成控制',
    });
    const second = charterVersionSchema.parse(
      await jsonOf(
        await call(handle, 'POST', `/api/research/projects/${projectId}/charter/approve`, {
          revisionReason: '换识别策略',
        }),
      ),
    );
    expect(second.version).toBe(2);
    expect(second.changedFields).toEqual(['researchMethod']);
    expect(
      charterBaselineResponseSchema.parse(
        await jsonOf(await call(handle, 'GET', `/api/research/projects/${projectId}/charter/baseline`)),
      ).baseline?.id,
    ).toBe(second.id);
  });

  it('refuses an unparseable approval and an unknown mark through the shared envelope', async () => {
    const handle = handlerOf();
    const projectId = await newProject(handle);

    const emptyReason = await call(handle, 'POST', `/api/research/projects/${projectId}/charter/approve`, {
      revisionReason: '',
    });
    expect(emptyReason.status).toBe(400);
    expect(apiErrorSchema.parse(await jsonOf(emptyReason)).error.code).toBe('invalid_request');

    // 批准要求理由，草稿还得先存在。
    const noDraft = await call(handle, 'POST', `/api/research/projects/${projectId}/charter/approve`, {
      revisionReason: '批准一个还没写的章程',
    });
    expect(apiErrorSchema.parse(await jsonOf(noDraft)).error.code).toBe('invalid_request');

    const absent = await call(handle, 'POST', '/api/research/review-marks/no-such-mark/clear');
    expect(absent.status).toBe(404);
    expect(apiErrorSchema.parse(await jsonOf(absent)).error.code).toBe('not_found');

    const badQuery = await call(handle, 'GET', `/api/research/projects/${projectId}/review-marks?status=stale`);
    expect(badQuery.status).toBe(400);
    expect(apiErrorSchema.parse(await jsonOf(badQuery)).error.code).toBe('invalid_request');
  });
});

/**
 * R03 的归档前检查 over the wire: one read-only route, keyed by the source rather than a project, because a
 * 出处 can be cited by several 研究项目 at once.
 */
describe('the research reference route', () => {
  it('reports the 证据 that cite a source and the 论点 they support', async () => {
    const handle = handlerOf();
    const projectId = await newProject(handle, '冷链物流服务质量研究');
    const claim = claimSchema.parse(
      await jsonOf(
        await call(handle, 'POST', `/api/research/projects/${projectId}/claims`, {
          claimCode: 'C1',
          claimText: '可靠性因素处于结构性中介位置。',
          claimType: 'empirical',
        }),
      ),
    );
    const evidence = evidenceSchema.parse(
      await jsonOf(
        await call(handle, 'POST', `/api/research/projects/${projectId}/evidence`, {
          type: 'interview',
          title: '访谈：王工 2026-03',
          nodeId: 'node-9',
          rawSourceId: 'raw-9',
          locationOrigin: 'captured',
        }),
      ),
    );
    expect(evidence).toMatchObject({ nodeId: 'node-9', rawSourceId: 'raw-9', locationOrigin: 'captured' });
    await call(handle, 'POST', `/api/research/projects/${projectId}/relations`, {
      sourceType: 'evidence',
      sourceId: evidence.id,
      relationType: 'supports',
      targetType: 'claim',
      targetId: claim.id,
    });

    const byNode = researchReferenceResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', '/api/research/references?nodeId=node-9')),
    );
    expect(byNode.references).toHaveLength(1);
    expect(byNode.references[0]).toMatchObject({
      projectId,
      projectName: '冷链物流服务质量研究',
      evidenceId: evidence.id,
      evidenceTitle: '访谈：王工 2026-03',
      evidenceType: 'interview',
      claimIds: [claim.id],
    });

    // The same walk from the raw capture, and a source nothing cites.
    const byRaw = researchReferenceResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', '/api/research/references?rawSourceId=raw-9')),
    );
    expect(byRaw.references.map((row) => row.evidenceId)).toEqual([evidence.id]);
    const none = researchReferenceResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', '/api/research/references?nodeId=node-never-cited')),
    );
    expect(none.references).toEqual([]);
  });

  it('refuses a query that names no source', async () => {
    const handle = handlerOf();
    const nothing = await call(handle, 'GET', '/api/research/references');
    expect(nothing.status).toBe(400);
    expect(apiErrorSchema.parse(await jsonOf(nothing)).error.code).toBe('invalid_request');

    // `?nodeId=` arrives as an empty string, which is 「没指名道」 rather than a search for ''.
    const blank = await call(handle, 'GET', '/api/research/references?nodeId=');
    expect(apiErrorSchema.parse(await jsonOf(blank)).error.code).toBe('invalid_request');
  });
});

describe('the drift, map and context-pack routes (P6)', () => {
  it('runs the deterministic drift check and de-duplicates on reruns', async () => {
    const handle = handlerOf();
    const projectId = await newProject(handle, '碳定价研究');
    const claim = claimSchema.parse(
      await jsonOf(
        await call(handle, 'POST', `/api/research/projects/${projectId}/claims`, {
          claimCode: 'C1',
          claimText: '观察到排放下降。',
          claimType: 'empirical',
          status: 'confirmed',
        }),
      ),
    );

    const first = driftCheckResponseSchema.parse(
      await jsonOf(await call(handle, 'POST', `/api/research/projects/${projectId}/drift-check`, {})),
    );
    expect(first.summary).toEqual({ total: 1, info: 0, warning: 0, critical: 1 });
    expect(first.findings[0]).toMatchObject({
      driftType: 'evidence_drift',
      sourceEntityType: 'claim',
      sourceEntityId: claim.id,
      status: 'open',
    });

    const second = driftCheckResponseSchema.parse(
      await jsonOf(await call(handle, 'POST', `/api/research/projects/${projectId}/drift-check`, {})),
    );
    expect(second.findings.map((finding) => finding.id)).toEqual(first.findings.map((finding) => finding.id));
  });

  it('lists findings with filters and flips a finding status over PATCH', async () => {
    const handle = handlerOf();
    const projectId = await newProject(handle);
    await call(handle, 'POST', `/api/research/projects/${projectId}/claims`, {
      claimCode: 'C1',
      claimText: '观察到排放下降。',
      claimType: 'empirical',
    });
    const run = driftCheckResponseSchema.parse(
      await jsonOf(await call(handle, 'POST', `/api/research/projects/${projectId}/drift-check`, {})),
    );
    const findingId = run.findings[0]!.id;
    expect(run.findings[0]?.severity).toBe('warning');

    const open = driftFindingListResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', `/api/research/projects/${projectId}/drift-findings?status=open`)),
    );
    expect(open.findings.map((finding) => finding.id)).toEqual([findingId]);
    const critical = driftFindingListResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', `/api/research/projects/${projectId}/drift-findings?severity=critical`)),
    );
    expect(critical.findings).toEqual([]);

    const patched = driftFindingSchema.parse(
      await jsonOf(await call(handle, 'PATCH', `/api/research/drift-findings/${findingId}`, { status: 'acknowledged' })),
    );
    expect(patched.status).toBe('acknowledged');
  });

  it('answers map and context-pack with their contract shapes', async () => {
    const handle = handlerOf();
    const projectId = await newProject(handle, '碳定价研究');
    await call(handle, 'PUT', `/api/research/projects/${projectId}/charter`, {
      workingTitle: 'W',
      coreContribution: 'C',
    });

    const map = researchMapResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', `/api/research/projects/${projectId}/map`)),
    );
    expect(map.project).toEqual({ id: projectId, name: '碳定价研究', status: 'active' });
    expect(map.charter.coreContribution).toBe('C');

    const pack = researchContextPackResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', `/api/research/projects/${projectId}/context-pack`)),
    );
    expect(pack.blocks[0]).toEqual({ heading: 'PROJECT', body: '碳定价研究' });
    expect(pack.markdown).toContain('## PROJECT');
    expect(Date.parse(pack.generatedAt)).not.toBeNaN();
  });

  it('answers not_found for an unknown project and an unknown finding', async () => {
    const handle = handlerOf();
    const missingMap = await call(handle, 'GET', '/api/research/projects/nope/map');
    expect(missingMap.status).toBe(404);
    const missingPatch = await call(handle, 'PATCH', '/api/research/drift-findings/nope', { status: 'open' });
    expect(missingPatch.status).toBe(404);
    expect(apiErrorSchema.parse(await jsonOf(missingPatch)).error.code).toBe('not_found');
  });
});
