/**
 * 写入验证探针 (§433 / M03). The rule these tests exist to hold is a negative one: no path through the
 * probe may end in 「验证完成」 without a record read back from Core. A stubbed `ProbeApi` is enough —
 * the point is which evidence each branch demands, not a live server.
 */
import { describe, expect, it } from 'vitest';
import type { CaptureRequest, CaptureResult, InboxEntry, InboxResponse, RawSource, SearchResponse } from '@noltri/schema';
import { describeProbeVerdict, planProbe, probeRequestId, readAgentProbe, runOwnProbe, PROBE_TITLE, type ProbeApi } from '../src/lib/probe';

const PLAN = planProbe('ab12cd34');

function captured(overrides: Partial<RawSource> = {}): RawSource {
  return {
    id: 'src-probe',
    userId: 'user-1',
    rawText: PLAN.own.text,
    surroundingContext: null,
    sourceType: 'manual',
    sourcePlatform: null,
    sourceApp: 'Claude Desktop',
    sourceTitle: PROBE_TITLE,
    sourceUrl: null,
    capturedAt: '2026-10-05T08:00:00.000Z',
    metadata: {},
    processingStatus: 'pending',
    errorReason: null,
    requestId: probeRequestId(PLAN),
    clientId: 'desktop',
    createdAt: '2026-10-05T08:00:00.000Z',
    ...overrides,
  };
}

function writeResult(overrides: Partial<CaptureResult> = {}): CaptureResult {
  return {
    rawSourceId: 'src-probe',
    requestId: probeRequestId(PLAN),
    stage: 'saved',
    duplicate: false,
    items: [],
    processingStatus: 'pending',
    ...overrides,
  };
}

function entry(overrides: Partial<InboxEntry> = {}): InboxEntry {
  return {
    id: 'src-agent',
    sourceType: 'agent',
    sourcePlatform: null,
    sourceApp: 'Claude Desktop',
    sourceTitle: null,
    sourceUrl: null,
    capturedAt: '2026-10-05T08:10:00.000Z',
    processingStatus: 'pending',
    errorReason: null,
    textPreview: PLAN.agent.text.slice(0, 60),
    rawTextLength: PLAN.agent.text.length,
    ...overrides,
  };
}

function feed(entries: InboxEntry[]): InboxResponse {
  return { entries, counts: { pending: entries.length, processing: 0, done: 0, failed: 0 }, limit: 50, offset: 0 };
}

function searchOf(text: string, nodeId: string | null = 'node-python'): SearchResponse {
  return {
    query: 'probe',
    mode: 'hybrid',
    hits: [{ itemId: 'item-1', nodeId, title: 'Python 笔记', text, score: 0.9, matchedBy: 'keyword', source: null }],
  };
}

interface Stub {
  readonly api: ProbeApi;
  readonly requests: CaptureRequest[];
}

function stubApi(over: Partial<ProbeApi> = {}): Stub {
  const requests: CaptureRequest[] = [];
  const api: ProbeApi = {
    capture: async (request) => {
      requests.push(request);
      return writeResult();
    },
    rawSource: async () => captured(),
    inbox: async () => feed([]),
    search: async () => ({ query: 'probe', mode: 'hybrid', hits: [] }),
    ...over,
  };
  return { api, requests };
}

describe('probe plan', () => {
  it('gives the two legs different markers and starts every text with its own', () => {
    expect(PLAN.own.marker).not.toBe(PLAN.agent.marker);
    expect(PLAN.own.text.startsWith(PLAN.own.marker)).toBe(true);
    expect(PLAN.agent.text.startsWith(PLAN.agent.marker)).toBe(true);
  });

  it('derives a stable request id so a second click is a duplicate, not a second probe', () => {
    expect(probeRequestId(PLAN)).toBe(`zn-probe-${PLAN.nonce.toLowerCase()}`);
    expect(probeRequestId(PLAN)).toBe(probeRequestId(planProbe(PLAN.nonce)));
  });
});

describe('runOwnProbe — 本机凭据的写入并读回', () => {
  it('submits the probe as a manual desktop capture under the client being tested', async () => {
    const { api, requests } = stubApi();
    const verdict = await runOwnProbe(api, PLAN, 'Claude Desktop');
    expect(verdict.ok).toBe(true);
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.requestId).toBe(probeRequestId(PLAN));
    expect(request?.capture.client).toBe('desktop');
    expect(request?.source).toEqual({ type: 'manual', appName: 'Claude Desktop', title: PROBE_TITLE });
  });

  it('reads the row back by the id the write returned and reports the evidence', async () => {
    const read: string[] = [];
    const { api } = stubApi({
      rawSource: async (id) => {
        read.push(id);
        return captured({ rawText: `${PLAN.own.text}（补一句上下文）` });
      },
    });
    const verdict = await runOwnProbe(api, PLAN, 'Claude Desktop');
    expect(read).toEqual(['src-probe']);
    if (!verdict.ok) throw new Error(`探针应当通过，实际：${verdict.detail}`);
    expect(verdict.evidence.rawSourceId).toBe('src-probe');
    expect(verdict.evidence.bytes).toBe(`${PLAN.own.text}（补一句上下文）`.length);
    expect(verdict.evidence.filedTo).toBeNull();
  });

  it('adds the search hit as filing evidence when the classifier already placed it', async () => {
    const { api } = stubApi({ search: async () => searchOf(PLAN.own.text) });
    const verdict = await runOwnProbe(api, PLAN, 'Claude Desktop');
    if (!verdict.ok) throw new Error(`探针应当通过，实际：${verdict.detail}`);
    expect(verdict.evidence.filedTo).toBe('Python 笔记（node-python）');
    expect(describeProbeVerdict(verdict)).toContain('检索已能命中');
  });

  const refusals = [
    { label: 'capture 失败', stub: stubApi({ capture: async () => Promise.reject(new Error('401 grant_revoked')) }), fragment: '探针写入失败' },
    { label: '读回失败', stub: stubApi({ rawSource: async () => Promise.reject(new Error('404 not_found')) }), fragment: '读回失败' },
    {
      label: '读回的不是同一条',
      stub: stubApi({ rawSource: async () => captured({ rawText: '与探针无关的旧文本，长度足够。' }) }),
      fragment: '读回的原文里找不到探针口令',
    },
  ];
  it.each(refusals)('refuses 验证完成 when $label', async ({ stub, fragment }) => {
    const verdict = await runOwnProbe(stub.api, PLAN, 'Claude Desktop');
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.detail).toContain(fragment);
    expect(describeProbeVerdict(verdict)).toContain('没有标记写入验证完成');
  });

  it('still calls the write verified when only 检索 is unavailable', async () => {
    const { api } = stubApi({ search: async () => Promise.reject(new Error('search offline')) });
    const verdict = await runOwnProbe(api, PLAN, 'Claude Desktop');
    if (!verdict.ok) throw new Error(`探针应当通过，实际：${verdict.detail}`);
    expect(verdict.evidence.filedTo).toBeNull();
    expect(describeProbeVerdict(verdict)).toContain('尚未归类');
  });

  it('says so when the same probe had already been written', async () => {
    const { api } = stubApi({ capture: async () => writeResult({ duplicate: true }) });
    const verdict = await runOwnProbe(api, PLAN, 'Claude Desktop');
    if (!verdict.ok) throw new Error(`探针应当通过，实际：${verdict.detail}`);
    expect(verdict.evidence.duplicate).toBe(true);
    expect(describeProbeVerdict(verdict)).toContain('此前已写入过同一条');
  });
});

describe('readAgentProbe — 只有工具写入才算', () => {
  it('reports 未验证 while nothing carries the Agent marker', async () => {
    const check = await readAgentProbe(stubApi().api, PLAN);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain(PLAN.agent.marker);
  });

  it('accepts a record the MCP tool wrote, with its own id and length', async () => {
    const { api } = stubApi({
      inbox: async () => feed([entry()]),
      rawSource: async () => captured({ id: 'src-agent', rawText: PLAN.agent.text, clientId: 'mcp', processingStatus: 'done' }),
    });
    const check = await readAgentProbe(api, PLAN);
    expect(check).toEqual({ ok: true, detail: expect.stringContaining('已由 MCP 工具写入并读回') });
    expect(check.detail).toContain('src-agent');
  });

  it('refuses a record this app wrote itself, naming where it came from', async () => {
    const { api } = stubApi({
      inbox: async () => feed([entry({ sourceApp: 'Setup Manager', sourceType: 'manual' })]),
      rawSource: async () => captured({ rawText: PLAN.agent.text, clientId: 'desktop' }),
    });
    const check = await readAgentProbe(api, PLAN);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('不是知序 MCP 工具');
  });

  it('refuses when the preview matches but the stored text does not', async () => {
    const { api } = stubApi({
      inbox: async () => feed([entry()]),
      rawSource: async () => captured({ rawText: '预览命中了口令，原文却对不上的一条记录。', clientId: 'mcp' }),
    });
    const check = await readAgentProbe(api, PLAN);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('读回不一致');
  });

  it('refuses when the feed itself cannot be read', async () => {
    const { api } = stubApi({ inbox: async () => Promise.reject(new Error('401 scope_not_granted')) });
    const check = await readAgentProbe(api, PLAN);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('无法判断 Agent 是否写入');
  });
});
