/**
 * Research HTTP contract (contract §1) through the shared `handle` — the same router Next.js and
 * node:http mount. The ResearchDomain is wired through `RouterDeps.research` exactly as production
 * wiring does (`core.research` fallback), so these tests exercise the real dispatch + envelope.
 */
import { describe, expect, it } from 'vitest';
import { createOfflineProvider } from '@noltri/ai-provider';
import {
  apiErrorSchema,
  charterResponseSchema,
  driftCheckResponseSchema,
  researchContextPackResponseSchema,
  researchMapResponseSchema,
  researchProjectListResponseSchema,
  researchProjectSchema,
  researchQuestionListResponseSchema,
  researchQuestionSchema,
} from '@noltri/schema';
import { silentLogger } from '@noltri/shared';
import { createInMemoryRepository } from '@noltri/storage';
import { createKnowledgeCore } from '../src/core';
import { createResearchDomain } from '../src/research';
import { createRequestHandler, type RequestHandler } from '../src/http/router';
import { FakeResearchRepository } from './research-fakes';
import { testConfig } from './fakes';

function handlerOf(): RequestHandler {
  const config = testConfig();
  const research = createResearchDomain(new FakeResearchRepository());
  const core = createKnowledgeCore({
    repository: createInMemoryRepository(),
    provider: createOfflineProvider({ embeddingDim: 1536 }),
    config,
    logger: silentLogger,
    research,
  });
  return createRequestHandler({ core, config, research });
}

async function jsonOf(response: Response): Promise<unknown> {
  return (await response.json()) as unknown;
}

async function call(
  handle: RequestHandler,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return handle(
    new Request(`http://core.local${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-noltri-client': 'web_app' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

describe('research http routes', () => {
  it('creates and lists projects over the wire with the frozen schemas', async () => {
    const handle = handlerOf();
    const created = await call(handle, 'POST', '/api/research/projects', { name: '碳定价研究' });
    expect(created.status).toBe(200);
    const project = researchProjectSchema.parse(await jsonOf(created));
    expect(project.name).toBe('碳定价研究');

    const list = await call(handle, 'GET', '/api/research/projects');
    expect(researchProjectListResponseSchema.parse(await jsonOf(list)).projects).toHaveLength(1);
  });

  it('serves the charter pair, including the null charter for a fresh project', async () => {
    const handle = handlerOf();
    const project = researchProjectSchema.parse(
      await jsonOf(await call(handle, 'POST', '/api/research/projects', { name: 'P' })),
    );

    const empty = charterResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', `/api/research/projects/${project.id}/charter`)),
    );
    expect(empty.charter).toBeNull();

    const saved = await call(handle, 'PUT', `/api/research/projects/${project.id}/charter`, {
      workingTitle: '碳定价与工业排放',
      coreContribution: '大样本因果估计',
    });
    expect(saved.status).toBe(200);
    const charter = charterResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', `/api/research/projects/${project.id}/charter`)),
    );
    expect(charter.charter?.workingTitle).toBe('碳定价与工业排放');
  });

  it('runs the questions row: create, list, patch', async () => {
    const handle = handlerOf();
    const project = researchProjectSchema.parse(
      await jsonOf(await call(handle, 'POST', '/api/research/projects', { name: 'P' })),
    );
    const question = researchQuestionSchema.parse(
      await jsonOf(
        await call(handle, 'POST', `/api/research/projects/${project.id}/questions`, {
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
      await jsonOf(await call(handle, 'GET', `/api/research/projects/${project.id}/questions`)),
    );
    expect(list.questions).toHaveLength(1);
  });

  it('answers drift-check, map and context-pack with their contract shapes', async () => {
    const handle = handlerOf();
    const project = researchProjectSchema.parse(
      await jsonOf(await call(handle, 'POST', '/api/research/projects', { name: 'P' })),
    );
    await call(handle, 'PUT', `/api/research/projects/${project.id}/charter`, {
      workingTitle: 'W',
      coreContribution: 'C',
    });

    const drift = driftCheckResponseSchema.parse(
      await jsonOf(await call(handle, 'POST', `/api/research/projects/${project.id}/drift-check`, {})),
    );
    expect(drift.summary.total).toBe(drift.findings.length);

    const map = researchMapResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', `/api/research/projects/${project.id}/map`)),
    );
    expect(map.project.id).toBe(project.id);

    const pack = researchContextPackResponseSchema.parse(
      await jsonOf(await call(handle, 'GET', `/api/research/projects/${project.id}/context-pack`)),
    );
    expect(pack.blocks.map((block) => block.heading)[0]).toBe('PROJECT');
  });

  it('deletes relations and reports {deleted,id}', async () => {
    const handle = handlerOf();
    const project = researchProjectSchema.parse(
      await jsonOf(await call(handle, 'POST', '/api/research/projects', { name: 'P' })),
    );
    const question = researchQuestionSchema.parse(
      await jsonOf(
        await call(handle, 'POST', `/api/research/projects/${project.id}/questions`, {
          questionCode: 'RQ1',
          questionText: 'q',
        }),
      ),
    );
    await call(handle, 'POST', `/api/research/projects/${project.id}/claims`, {
      claimCode: 'C1',
      claimText: 'x',
      claimType: 'empirical',
    });
    const claims = (await jsonOf(await call(handle, 'GET', `/api/research/projects/${project.id}/claims`))) as {
      claims: { id: string }[];
    };
    const created = (await jsonOf(
      await call(handle, 'POST', `/api/research/projects/${project.id}/relations`, {
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
});
