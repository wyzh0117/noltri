/**
 * The one network flow both the pill and the paste window share: build the frozen capture request
 * (client "desktop"), re-validate it against the published schema, send it through ApiClient, and
 * report the outcome back to the Rust layer so every window agrees on the last result.
 */
import { ApiClient, buildCaptureRequest } from '@noltri/api-client';
import { captureRequestSchema, type CaptureResult, type CaptureResultItem } from '@noltri/schema';
import { commands } from './tauri';

export interface CaptureFlowConfig {
  readonly apiBaseUrl: string;
  readonly apiToken: string;
}

export interface CaptureFlowInput {
  readonly text: string;
  readonly appName?: string;
  readonly windowTitle?: string;
  /** `pill` | `paste` | `shortcut` — recorded so 最近收纳 shows where it came from. */
  readonly via: 'pill' | 'paste' | 'shortcut';
}

export interface CaptureFlowOutcome {
  readonly ok: boolean;
  readonly length: number;
  readonly appName: string;
  readonly path: string[];
  readonly message: string;
  readonly via: string;
}

const VIA_LABEL: Record<CaptureFlowInput['via'], string> = {
  pill: '悬浮球',
  paste: '粘贴收纳',
  shortcut: '快捷键',
};

export async function runCaptureFlow(config: CaptureFlowConfig, input: CaptureFlowInput): Promise<CaptureFlowOutcome> {
  const request = buildCaptureRequest({
    text: input.text,
    client: 'desktop',
    source: {
      type: 'desktop_app',
      ...(input.appName ? { appName: input.appName } : {}),
      ...(input.windowTitle ? { title: input.windowTitle } : {}),
    },
  });
  const parsed = captureRequestSchema.safeParse(request);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const outcome = await report(config, {
      ok: false,
      length: input.text.length,
      appName: input.appName ?? '未知应用',
      path: [],
      message: `请求未通过捕获契约（${issue?.message ?? 'unknown'}），内容未发送。`,
      via: input.via,
    });
    return outcome;
  }

  const client = new ApiClient({
    baseUrl: config.apiBaseUrl,
    ...(config.apiToken.trim() === '' ? {} : { token: config.apiToken.trim() }),
  });

  let result: CaptureResult;
  try {
    result = await client.capture(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    return await report(config, {
      ok: false,
      length: input.text.length,
      appName: input.appName ?? '未知应用',
      path: [],
      message: `收纳失败：${message}`,
      via: input.via,
    });
  }

  if (result.processingStatus === 'failed') {
    return await report(config, {
      ok: false,
      length: input.text.length,
      appName: input.appName ?? '未知应用',
      path: [],
      message: `原文已保存，AI 归纳失败：${result.errorReason ?? '未知原因'}（可稍后重试）`,
      via: input.via,
    });
  }

  const paths = result.items.map((item: CaptureResultItem) => item.nodePath.join(' / '));
  return await report(config, {
    ok: true,
    length: input.text.length,
    appName: input.appName ?? '未知应用',
    path: result.items[0]?.nodePath ?? [],
    message:
      result.items.length === 0
        ? '没有提取出知识点，原文已保存。'
        : `已收纳 ${String(result.items.length)} 条：${paths.join('；')}`,
    via: input.via,
  });
}

async function report(config: CaptureFlowConfig, outcome: CaptureFlowOutcome): Promise<CaptureFlowOutcome> {
  try {
    await commands.recordCaptureOutcome({
      ok: outcome.ok,
      length: outcome.length,
      appName: outcome.appName,
      path: outcome.path,
      message: outcome.message,
      via: outcome.via,
    });
  } catch {
    // Outcome persistence is best-effort; the user-facing result is the message itself.
  }
  return outcome;
}

export { VIA_LABEL };
