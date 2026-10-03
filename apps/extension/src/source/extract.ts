import { deriveTitle, normalizeKnowledgeText, truncate } from '@noltri/shared';
import type { CaptureSource, SourceType } from '@noltri/schema';

/**
 * V1 §10.4 only asks for "适量 surrounding context". 800 characters on each side is enough for the
 * Knowledge Core classifier to see the local meaning of a sentence, while the 1200-character combined
 * cap (§ the extension's own budget, well under MAX_SURROUNDING_CONTEXT_LENGTH) keeps a capture from
 * ever turning into a page dump.
 */
export const SURROUNDING_CONTEXT_WINDOW = 800;
export const SURROUNDING_CONTEXT_TOTAL_MAX = 1200;
export const SURROUNDING_CONTEXT_JOINER = '\n';
export const MAX_SOURCE_TITLE_LENGTH = 600;
export const MAX_SOURCE_URL_LENGTH = 2048;
export const OWN_UI_ID_PREFIX = 'noltri-';

export const TEXT_NODE_TYPE = 3;
export const ELEMENT_NODE_TYPE = 1;

const PRODUCT_PLATFORMS: Readonly<Record<string, string>> = {
  'chatgpt.com': 'ChatGPT',
  'openai.com': 'ChatGPT',
  'claude.ai': 'Claude',
  'gemini.google.com': 'Gemini',
  'perplexity.ai': 'Perplexity',
};

/** Page machinery, never knowledge. Generic DOM hygiene only — no per-site rules anywhere in this file. */
const NON_CONTENT_NAMES: ReadonlySet<string> = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'IFRAME',
  'CANVAS',
  'SVG',
  'svg',
  '#comment',
  '#document-type',
]);

export interface ContentTree {
  readonly nodeName: string;
  readonly id?: string;
  readonly text?: string;
  readonly children?: readonly ContentTree[];
}

export interface TreePosition {
  readonly path: readonly number[];
  readonly offset: number;
}

export function domainLabel(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^www\./, '').replace(/\.+$/, '');
}

/** Pure hostname → label. Source labelling for `CaptureRequest.source`, never DOM adaptation. */
export function platformFromHostname(hostname: string): string {
  const label = domainLabel(hostname);
  if (label.length === 0) return '网页';
  return productPlatform(hostname) ?? label;
}

export function productPlatform(hostname: string): string | undefined {
  const label = domainLabel(hostname);
  if (label.length === 0) return undefined;
  const registered = label.split('.').slice(-2).join('.');
  return PRODUCT_PLATFORMS[registered] ?? PRODUCT_PLATFORMS[label];
}

const CONTENT_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'file:']);

/** Only real content origins become source metadata; `chrome://` and friends carry no provenance. */
export function parseHttpHref(href: string): URL | undefined {
  try {
    const url = new URL(href);
    return CONTENT_PROTOCOLS.has(url.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}

export interface SourcePageInput {
  readonly href: string;
  readonly title: string;
  readonly type?: SourceType;
}

export function buildSource(input: SourcePageInput): CaptureSource {
  const type = input.type ?? 'web';
  if (type === 'manual') {
    return { type: 'manual', appName: '知序 Noltri 扩展' };
  }
  const title = truncate(input.title.trim().length > 0 ? input.title.trim() : deriveTitle(input.title), MAX_SOURCE_TITLE_LENGTH);
  const url = parseHttpHref(input.href);
  if (!url) return title.length > 0 ? { type, title } : { type };
  const platform = platformFromHostname(url.hostname);
  const appName = productPlatform(url.hostname);
  return {
    type,
    platform,
    ...(appName ? { appName } : {}),
    ...(title.length > 0 ? { title } : {}),
    url: truncate(url.href, MAX_SOURCE_URL_LENGTH),
  };
}

export interface SurroundingContextInput {
  /** Text of the selection's own container, already extracted by `textOfContentTree` — never a page. */
  readonly parentText: string;
  readonly start: number;
  readonly end: number;
  readonly windowSize?: number;
  readonly totalMax?: number;
}

/** Character-offset window around the selection. The selection text itself is not repeated here. */
export function deriveSurroundingContext(input: SurroundingContextInput): string {
  const windowSize = input.windowSize ?? SURROUNDING_CONTEXT_WINDOW;
  const totalMax = input.totalMax ?? SURROUNDING_CONTEXT_TOTAL_MAX;
  const text = input.parentText;
  if (windowSize <= 0 || totalMax <= 0) return '';
  const start = Math.max(0, Math.min(text.length, Math.floor(input.start)));
  const end = Math.max(start, Math.min(text.length, Math.floor(input.end)));
  const before = tidy(text.slice(Math.max(0, start - windowSize), start));
  const after = tidy(text.slice(end, end + windowSize));
  const beforeShare = Math.min(before.length, Math.max(0, totalMax - Math.min(after.length, Math.floor(totalMax / 2))));
  const afterShare = Math.min(after.length, Math.max(0, totalMax - beforeShare));
  return [before.slice(before.length - beforeShare), after.slice(0, afterShare)].filter((part) => part.length > 0).join(SURROUNDING_CONTEXT_JOINER);
}

function tidy(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Flattens a DOM subtree into the plain shape this module reasons about. Reads the given node only. */
export function contentTreeFromNode(node: Node): ContentTree {
  if (node.nodeType === TEXT_NODE_TYPE) return { nodeName: node.nodeName, text: node.textContent ?? '' };
  if (node.nodeType !== ELEMENT_NODE_TYPE) return { nodeName: node.nodeName, text: '' };
  const element = node as Element;
  const children: ContentTree[] = [];
  for (const child of Array.from(element.childNodes)) children.push(contentTreeFromNode(child));
  return { nodeName: element.nodeName, id: element.id.length > 0 ? element.id : undefined, children };
}

function isExcluded(tree: ContentTree): boolean {
  const name = tree.nodeName.toUpperCase();
  return NON_CONTENT_NAMES.has(name) || NON_CONTENT_NAMES.has(tree.nodeName) || (tree.id !== undefined && tree.id.startsWith(OWN_UI_ID_PREFIX));
}

export function textOfContentTree(tree: ContentTree): string {
  if (isExcluded(tree)) return '';
  if (tree.text !== undefined) return tree.text;
  return (tree.children ?? []).map(textOfContentTree).join('');
}

/** Offset of a position inside `textOfContentTree(root)`, or null when the path leaves the tree or lands in excluded text. */
export function offsetOfPosition(root: ContentTree, position: TreePosition): number | null {
  let before = 0;
  let current: ContentTree = root;
  for (const index of position.path) {
    const children = current.children;
    if (children === undefined || index < 0 || index >= children.length) return null;
    for (let sibling = 0; sibling < index; sibling += 1) {
      const child = children[sibling];
      if (child !== undefined) before += textOfContentTree(child).length;
    }
    const next = children[index];
    if (next === undefined || isExcluded(next)) return null;
    current = next;
  }
  const leafText = current.text;
  if (leafText === undefined) return before;
  return before + Math.max(0, Math.min(position.offset, leafText.length));
}

/** Index path from `container` down to `target`; null when the node is not inside the container. */
export function pathWithinContainer(container: Node, target: Node): number[] | null {
  const path: number[] = [];
  let current: Node | null = target;
  while (current && current !== container) {
    const parent: Node | null = current.parentNode;
    if (!parent) return null;
    path.unshift(Array.from<Node>(parent.childNodes).indexOf(current));
    current = parent;
  }
  return current === container ? path : null;
}

/**
 * Context container for a range: the selection's own block, grown upwards only while it stays smaller
 * than one window, and never past `body`/`html`/`main`/`article` — V1 §10.4 forbids collecting a page.
 */
export function pickContextContainer(range: Range): Element | null {
  const start = range.startContainer;
  let current: Element | null = start.nodeType === ELEMENT_NODE_TYPE ? (start as Element) : start.parentElement;
  let last: Element | null = null;
  while (current && !isPageRoot(current)) {
    last = current;
    if (textOfContentTree(contentTreeFromNode(current)).length >= SURROUNDING_CONTEXT_WINDOW * 2) return current;
    current = current.parentElement;
  }
  return last;
}

function isPageRoot(element: Element): boolean {
  const tag = element.tagName.toUpperCase();
  return tag === 'HTML' || tag === 'BODY' || tag === 'MAIN' || tag === 'ARTICLE';
}

export interface SelectionIntent {
  text: string;
  source: CaptureSource;
  surroundingContext?: string;
}

/**
 * The single place a page selection becomes a capture intent. Both the floating pill and the context
 * menu go through it, which is what makes the two entry points send the same payload.
 */
export function readSelectionIntent(forcedText?: string): SelectionIntent | null {
  const selection = window.getSelection();
  const liveText = selection && selection.rangeCount > 0 ? selection.toString() : '';
  const text = normalizeKnowledgeText(forcedText && forcedText.length > 0 ? forcedText : liveText);
  if (text.length === 0) return null;
  const source = buildSource({ href: location.href, title: document.title });
  const surroundingContext = readSurroundingFromSelection();
  return { text, source, ...(surroundingContext ? { surroundingContext } : {}) };
}

function readSurroundingFromSelection(): string | undefined {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  const container = pickContextContainer(range);
  if (!container) return undefined;
  const tree = contentTreeFromNode(container);
  const parentText = textOfContentTree(tree);
  const startPath = pathWithinContainer(container, range.startContainer);
  const endPath = pathWithinContainer(container, range.endContainer);
  if (startPath === null || endPath === null) return undefined;
  const start = offsetOfPosition(tree, { path: startPath, offset: range.startOffset });
  const end = offsetOfPosition(tree, { path: endPath, offset: range.endOffset });
  if (start === null || end === null || end < start) return undefined;
  const context = deriveSurroundingContext({ parentText, start, end });
  return context.length > 0 ? context : undefined;
}
