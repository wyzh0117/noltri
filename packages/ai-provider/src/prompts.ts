/**
 * Prompt contracts for the OpenAI-compatible adapter.
 * Bilingual by design: product language is 简体中文, model rules stay English-coupled.
 */

import type { ChatMessage, ClassificationCandidate } from './types';

export const NODE_CONTEXT_LABEL = '节点上下文';

const OUTPUT_CONTRACT_EXTRACT =
  '{"items":[{"text":"…","summary":"…","confidence":0.82,"suggestedTitle":"…"}]}';

const OUTPUT_CONTRACT_ATTACH =
  '{"action":"attach","nodeId":"候选 id","confidence":0.86,"reason":"一句话中文依据"}';

const OUTPUT_CONTRACT_CREATE =
  '{"action":"create","newNodeTitle":"…","newNodePath":["领域","小节"],"confidence":0.6,"reason":"一句话中文依据"}';

export const JSON_ONLY_REMINDER =
  '现在无法启用 response_format。请只输出一个合法 JSON 对象：双引号、无注释、无尾逗号，' +
  '不要任何解释文字。You may wrap the JSON in a ```json fenced block, but add nothing else. ' +
  '必须严格遵守上述输出契约 / obey the output contract exactly.';

export function extractSystemPrompt(maxItems: number): string {
  return (
    '你是「知序 Noltri」的知识提取引擎 / You are the knowledge-extraction engine of Noltri.\n' +
    '任务：把用户选中的原文切分成若干条原子、自足的知识点。\n' +
    'Task: split the user\'s selected text into atomic, self-contained knowledge points.\n' +
    '\n' +
    '规则 / Rules:\n' +
    '1. 每条知识点独立可读，不依赖上下文；只在选中原文内部消解指代。\n' +
    '   Each item must read standalone; resolve pronouns only from within the selected text.\n' +
    '2. 只使用选中原文已有的事实，绝不虚构、绝不补充外部知识、绝不推断。\n' +
    '   Never invent facts and never add outside knowledge.\n' +
    '3. 保留原始术语、代码、数字、单位与英文专有名词，不做意译替换。\n' +
    '   Keep original terminology, code, numbers and proper nouns verbatim.\n' +
    '4. 丢弃纯导航、菜单、Cookie 提示、页脚、按钮文案、广告与模板套话。\n' +
    '   Drop pure navigation, boilerplate, banner/footer/button text and ads.\n' +
    `5. 最多 ${String(maxItems)} 条，按价值排序；没有可保留内容时返回 {"items":[]}。\n` +
    `   Honour the cap of ${String(maxItems)} items; return an empty items array when nothing qualifies.\n` +
    '6. confidence 是 0 到 1 的小数，表示「直接来自原文且自足」的把握度，不要写成语句。\n' +
    '   confidence is a number in 0..1, never a string.\n' +
    '7. text 为知识点正文；summary 不超过 60 个字符；suggestedTitle 不超过 24 个字符。\n' +
    '   summary <= 60 chars, suggestedTitle <= 24 chars.\n' +
    '8. 「参考上下文」只用于理解术语与指代，绝不能作为抽取来源，也不得复制进 text。\n' +
    '   Reference context is for disambiguation only and must never become extracted text.\n' +
    '9. 只输出 JSON / Output JSON only, matching exactly:\n' +
    OUTPUT_CONTRACT_EXTRACT
  );
}

export function buildExtractUserPrompt(fields: {
  text: string;
  surroundingContext?: string;
  sourceLabel: string;
  sourceType: string;
  maxItems: number;
}): string {
  const context = fields.surroundingContext?.trim();
  const blocks = [
    `来源 / Source：${fields.sourceLabel}（类型 ${fields.sourceType}）`,
    `最多条数 / max items：${String(fields.maxItems)}`,
    '',
    '【选中原文 — 唯一抽取来源 / SELECTED TEXT — the only extraction source】',
    '"""',
    fields.text,
    '"""',
  ];
  if (context !== undefined && context.length > 0) {
    blocks.push(
      '',
      '【参考上下文 — 仅供理解，禁止抽取 / REFERENCE CONTEXT — never an extraction source】',
      '"""',
      context,
      '"""',
    );
  }
  blocks.push('', '请按契约返回 JSON。/ Return JSON following the contract.');
  return blocks.join('\n');
}

export function classifySystemPrompt(attachThreshold: number): string {
  return (
    '你是「知序 Noltri」的知识归档引擎 / You are the classification engine of Noltri.\n' +
    '任务：判断这条知识点应当挂到已有节点（attach），还是新建节点（create）。\n' +
    'Task: decide whether this item should attach to an existing node or create a new one.\n' +
    '\n' +
    '规则 / Rules:\n' +
    '1. action 只能是 "attach" 或 "create"。\n' +
    '2. attach 时 nodeId 必须逐字来自给定候选列表，禁止编造、禁止改写 id。\n' +
    '   nodeId must be copied verbatim from the supplied candidate list; never invent one.\n' +
    `3. 只有把握度 >= ${String(attachThreshold)}（attachThreshold）时才 attach；低于阈值一律 create。\n` +
    '   Attach only when your confidence clears attachThreshold; otherwise create.\n' +
    '4. create 时 newNodeTitle 为简体中文、不超过 24 个字符；newNodePath 是「根 → 叶」层级数组，' +
    '1 到 3 级，最后一个元素应与 newNodeTitle 一致。优先复用候选里已出现的领域名，不要虚构多余层级。\n' +
    '   newNodePath is a root-to-leaf array of 1..3 levels; reuse domain names that already appear ' +
    'in the candidates instead of inventing extra levels.\n' +
    '5. reason 是一句简体中文，不超过 40 个字符。\n' +
    '6. confidence 是 0 到 1 的小数，不要写成语句。\n' +
    '7. 只输出 JSON / Output JSON only, exactly one of:\n' +
    OUTPUT_CONTRACT_ATTACH +
    '\n或 / or\n' +
    OUTPUT_CONTRACT_CREATE
  );
}

export function buildClassifyUserPrompt(fields: {
  itemText: string;
  suggestedTitle?: string;
  candidates: ClassificationCandidate[];
  attachThreshold: number;
  scopeHint?: string;
}): string {
  const compact = fields.candidates.map((candidate) => ({
    id: candidate.id,
    title: candidate.title,
    summary: candidate.summary ?? null,
    path: candidate.path,
    itemCount: candidate.itemCount ?? null,
  }));
  return [
    `待归档知识点 / ITEM TO CLASSIFY：\n"""\n${fields.itemText}\n"""`,
    '',
    `建议标题 / suggested title：${fields.suggestedTitle?.trim() || '（无 / none）'}`,
    `归档阈值 / attachThreshold：${String(fields.attachThreshold)}`,
    `作用域提示 / scopeHint：${fields.scopeHint ?? '（未指定 / none）'}`,
    '',
    `候选节点列表 / CANDIDATE NODES（共 ${String(compact.length)} 个，nodeId 只能取其中的 id）：`,
    JSON.stringify(compact, null, 0),
    '',
    '请按契约返回 JSON。/ Return JSON following the contract.',
  ].join('\n');
}

export function classifyCorrectionMessage(problem: string): string {
  return (
    `上一次输出不可用 / your previous reply was unusable：${problem}。\n` +
    '请重新决定，nodeId 必须逐字来自上面候选节点列表的 id；若没有合适的候选节点，' +
    '就返回 action="create" 并给出 newNodeTitle 与 newNodePath。' +
    '只输出 JSON，遵守原契约。'
  );
}

export function withJsonOnlyReminder(messages: ChatMessage[]): ChatMessage[] {
  const [first, ...rest] = messages;
  if (first !== undefined && first.role === 'system') {
    return [{ role: 'system', content: `${first.content}\n\n${JSON_ONLY_REMINDER}` }, ...rest];
  }
  return [{ role: 'system', content: JSON_ONLY_REMINDER }, ...messages];
}
