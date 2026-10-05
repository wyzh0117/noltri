/**
 * 写入验证探针 (V1 §433 / M03).
 *
 * "找到配置文件" and "HTTP 200" are not evidence that a client can write. §433 asks for a dedicated
 * probe written into a project the user agreed to and then read back, so this module writes one probe
 * sentence and reads it through a *different* endpoint before anything may be called 验证完成.
 *
 * Two verdicts stay apart on purpose. What this app can prove is that the credential it just handed
 * out reaches the same database the MCP server proxies. That an Agent actually called its 知序 tool can
 * only be proved by reading a record whose client is `mcp` — so the second check looks for that record
 * instead of inferring it from a successful handshake.
 */
import { buildCaptureRequest } from '@noltri/api-client';
import type {
  CaptureRequest,
  CaptureResult,
  InboxResponse,
  RawSource,
  SearchRequest,
  SearchResponse,
} from '@noltri/schema';

export const PROBE_TITLE = '知序写入验证探针';

export interface ProbePhrase {
  readonly marker: string;
  readonly text: string;
}

export interface ProbePlan {
  readonly nonce: string;
  /** Written by this app, with the credential that went into the client's config file. */
  readonly own: ProbePhrase;
  /** Handed to the user to ask the Agent to save it through its 知序 tool. */
  readonly agent: ProbePhrase;
}

/**
 * The marker sits at the head of the text because 收件箱 only previews it; a probe that cannot be
 * recognised in a preview cannot be read back.
 */
export function planProbe(nonce: string): ProbePlan {
  const own: ProbePhrase = {
    marker: `ZN-PROBE-${nonce}-A`,
    text: `ZN-PROBE-${nonce}-A 这是知序 Setup Manager 的写入验证探针，由本机以该客户端的授权凭据写入，用于确认凭据确实能写入并读回。确认后可在收件箱归档到诊断项目。`,
  };
  const agent: ProbePhrase = {
    marker: `ZN-PROBE-${nonce}-B`,
    text: `ZN-PROBE-${nonce}-B 这是知序写入验证探针，请由该客户端的知序工具保存，用于确认工具确实写进了同一个本地知识库。`,
  };
  return { nonce, own, agent };
}

/** Stable per probe: a second click answers 重复 instead of writing a second copy of the probe. */
export function probeRequestId(plan: ProbePlan): string {
  return `zn-probe-${plan.nonce.toLowerCase()}`;
}

/** The methods a probe needs; `ApiClient` satisfies this, and a test fake can too. */
export interface ProbeApi {
  capture(request: CaptureRequest): Promise<CaptureResult>;
  rawSource(id: string): Promise<RawSource>;
  inbox(query?: { status?: string; limit?: number; offset?: number }): Promise<InboxResponse>;
  search(request: SearchRequest): Promise<SearchResponse>;
}

export interface ProbeEvidence {
  readonly rawSourceId: string;
  readonly marker: string;
  readonly bytes: number;
  readonly processingStatus: string;
  readonly duplicate: boolean;
  /** Where the read-back search found it; null means the text is stored but not filed yet. */
  readonly filedTo: string | null;
}

export type ProbeVerdict =
  | { readonly ok: true; readonly evidence: ProbeEvidence }
  | { readonly ok: false; readonly detail: string };

export type ProbeCheck = { readonly ok: boolean; readonly detail: string };

/**
 * Write with the client's own credential, then read the same row back through 收件箱's single-source
 * endpoint. Every failure path refuses: a probe that could not be read back never reports 验证完成.
 */
export async function runOwnProbe(api: ProbeApi, plan: ProbePlan, sourceApp: string): Promise<ProbeVerdict> {
  let written: CaptureResult;
  try {
    written = await api.capture(
      buildCaptureRequest({
        requestId: probeRequestId(plan),
        text: plan.own.text,
        source: { type: 'manual', appName: sourceApp, title: PROBE_TITLE },
        client: 'desktop',
      }),
    );
  } catch (error) {
    return { ok: false, detail: `探针写入失败：${reasonOf(error)}。没有标记写入验证完成。` };
  }

  let stored: RawSource;
  try {
    stored = await api.rawSource(written.rawSourceId);
  } catch (error) {
    return {
      ok: false,
      detail: `写入返回了来源 ${written.rawSourceId}，但按它读回失败：${reasonOf(error)}。没有标记写入验证完成。`,
    };
  }
  if (!stored.rawText.includes(plan.own.marker)) {
    return { ok: false, detail: '读回的原文里找不到探针口令，写入与读回不是同一条记录。没有标记写入验证完成。' };
  }

  return {
    ok: true,
    evidence: {
      rawSourceId: written.rawSourceId,
      marker: plan.own.marker,
      bytes: stored.rawText.length,
      processingStatus: stored.processingStatus,
      duplicate: written.duplicate,
      filedTo: await findFiling(api, plan.own.marker),
    },
  };
}

/** A missing 检索 hit is not a failed write: the offline driver files nothing until a person does. */
async function findFiling(api: ProbeApi, marker: string): Promise<string | null> {
  try {
    const hits = (await api.search({ query: marker, limit: 5 })).hits;
    const hit = hits.find((entry) => entry.text.includes(marker) || entry.title.includes(marker));
    if (hit === undefined) return null;
    return hit.nodeId === null ? hit.title : `${hit.title}（${hit.nodeId}）`;
  } catch {
    return null;
  }
}

/**
 * Only a record the MCP tool wrote counts. A preview that merely contains the probe marker but carries
 * another client id is this app's own probe coming back, which would make the claim circular.
 */
export async function readAgentProbe(api: ProbeApi, plan: ProbePlan): Promise<ProbeCheck> {
  let feed: InboxResponse;
  try {
    feed = await api.inbox({ limit: 50 });
  } catch (error) {
    return { ok: false, detail: `读取收件箱失败，无法判断 Agent 是否写入：${reasonOf(error)}` };
  }
  const candidates = feed.entries.filter((entry) => entry.textPreview.includes(plan.agent.marker));
  if (candidates.length === 0) {
    return { ok: false, detail: `还没有找到含 ${plan.agent.marker} 的记录。请在客户端里让 Agent 用知序工具保存那句话，再回来检查。` };
  }
  for (const entry of candidates) {
    let row: RawSource;
    try {
      row = await api.rawSource(entry.id);
    } catch (error) {
      return { ok: false, detail: `找到 ${plan.agent.marker} 但读不回原文：${reasonOf(error)}` };
    }
    if (row.clientId === 'mcp') {
      if (!row.rawText.includes(plan.agent.marker)) {
        return { ok: false, detail: `记录 ${entry.id} 的预览含探针口令，原文却不含，读回不一致，不能标记验证完成。` };
      }
      return {
        ok: true,
        detail: `已由 MCP 工具写入并读回：${entry.id}｜${String(row.rawText.length)} 字｜归类 ${row.processingStatus}。`,
      };
    }
  }
  return {
    ok: false,
    detail: `找到含 ${plan.agent.marker} 的记录，但写入方标记为 ${candidates
      .map((entry) => entry.sourceApp ?? entry.sourceType)
      .join('、')}，不是知序 MCP 工具。不能据此标记「经 Agent 写入验证完成」。`,
  };
}

export function describeProbeVerdict(verdict: ProbeVerdict): string {
  if (!verdict.ok) return verdict.detail;
  const { evidence } = verdict;
  const filed = evidence.filedTo === null ? '尚未归类，可在收件箱归档到诊断项目' : `检索已能命中：${evidence.filedTo}`;
  return `${evidence.marker} 已写入并读回（${String(evidence.bytes)} 字｜归类 ${evidence.processingStatus}${
    evidence.duplicate ? '｜此前已写入过同一条' : ''
  }）｜${filed}`;
}

function reasonOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return '未知原因';
}
