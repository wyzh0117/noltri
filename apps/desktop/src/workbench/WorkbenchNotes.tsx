import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import type { CachedNoteMetadata, NoteFile, NoteHistoryResponse, NoteSearchResponse, VaultEntry, VaultSettings, VaultSnapshot } from '@noltri/schema';
import YAML from 'yaml';
import { describeError } from './api';
import type { WorkbenchApi } from './api';
import { NotesEditor } from './NotesEditor';
import { NoteBodyPresentation } from './NoteBodyPresentation';
import { NoteInterpretationPanel } from './NoteInterpretationPanel';
import type { RightTool, RightToolPanels } from './KnowledgeRightPanel';
import { classifyNoteChange, classifyVaultDraftRecovery, createVaultDraftWriteQueue, decodeVaultDraftRecord, drainNoteFlush, extractSubpath, fuzzyMatchRanges, groupMarkdownTokens, historyDiffLines, incompleteWikiLinkAt, markdownBlockRanges, markdownReaderTarget, movedMarkdownHistoryPaths, normalizeTextRanges, remapVaultPath, replaceMentionAt, safeDecodeVaultFragment, safeNoteHref, saveLatestNoteWithEtag, setFrontmatterProperty, vaultContextMatches, vaultLinkPathCandidates, vaultPathContextMatches, vaultPathContains, writeVaultDraftRecord } from './notes-model';
import type { TextRange, VaultContextIdentity, VaultDraftMetadata } from './notes-model';
import './notes-workbench.css';

type EditorMode = 'live' | 'source' | 'read';
type SaveState = 'saved' | 'saving' | 'dirty' | 'conflict' | 'error';
type VaultLinkKind = 'wikilink' | 'markdown';

export interface RelatedSourceDocument { path: string; sourceId: string; title: string }

interface WorkbenchNotesProps {
  api: WorkbenchApi;
  active: boolean;
  displayMode?: 'cards' | 'editor';
  contentView?: ReactNode;
  commandRequestId?: number;
  searchQuery?: string;
  onRequestToolChange?: (tool: RightTool) => void;
  onSearchRequest?: (query: string) => void;
  onNavigateRequest?: (path: string | null, subpath?: string | null, intent?: { newTab: boolean; split: boolean }) => void;
  requestedOpen: { path: string; intent: { newTab: boolean; split: boolean }; id: number; subpath?: string | null; draftContent?: string; legacyDraft?: { topicId: string; chapterId: string | null; content: string }; semanticIdentity?: SemanticNoteIdentity } | null;
  scopePaths: ReadonlySet<string> | null;
  scopeTitle: string | null;
  libraryView: 'all' | 'organize' | 'archive';
  previewRequest?: { path: string; anchor: DOMRect | null; id: number } | null;
  assetRequest?: { path: string; id: number } | null;
  tagQuery: string | null;
  vaultTagCounts: ReadonlyMap<string, number>;
  onContextChange: (rootPath: string, selectedPath: string | null, revision: number, frontmatter: Record<string, unknown> | null, relatedSources: RelatedSourceDocument[]) => void;
  onUpdateSafetyChange?: (safe: boolean) => void;
  onVaultDocumentsChanged?: (paths: readonly string[]) => void;
  onVaultEntriesChange?: (entries: readonly VaultEntry[]) => void;
  onRegisterFlushHandler?: (handler: () => Promise<boolean>) => void | (() => void);
  onRightPanelContentChange?: (content: { toolPanels: RightToolPanels; interpretationPanel: ReactNode }, signature: string) => void;
  onLegacyDraftSaved?: (draft: { topicId: string; chapterId: string | null; content: string }) => void;
}

interface TrustSettings { html: boolean; mermaid: boolean }
interface SemanticNoteIdentity { topicId: string; chapterId: string | null }
interface LoadedNoteOwner extends VaultContextIdentity { path: string; id: number }
type PropertyType = 'text' | 'number' | 'boolean' | 'list' | 'yaml';
const propertyTypeValues = new Set<PropertyType>(['text', 'number', 'boolean', 'list', 'yaml']);

function parseLegacyPropertyTypes(raw: string): Record<string, PropertyType> {
  const value: unknown = JSON.parse(raw);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('旧属性类型设置必须是对象。');
  const entries = Object.entries(value);
  if (entries.some(([, type]) => typeof type !== 'string' || !propertyTypeValues.has(type as PropertyType))) {
    throw new Error('旧属性类型设置包含不支持的类型；原设置已保留。');
  }
  return Object.fromEntries(entries) as Record<string, PropertyType>;
}

function normalizedVaultSettings(settings: VaultSettings): VaultSettings {
  return { ...settings, propertyTypes: settings.propertyTypes ?? {} };
}

function errorText(error: unknown): string {
  return describeError(error);
}

function draftKey(root: string, path: string): string {
  return `noltri:vault-draft:${encodeURIComponent(root)}:${encodeURIComponent(path)}`;
}

function readDraftRecord(root: string, path: string): ReturnType<typeof decodeVaultDraftRecord> | null {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(draftKey(root, path));
  } catch { return null; }
  if (raw === null) return null;
  return decodeVaultDraftRecord(raw);
}

function getDraft(root: string, path: string): string | null {
  return readDraftRecord(root, path)?.content ?? null;
}

function setDraft(root: string, path: string, content: string | null, metadata?: VaultDraftMetadata): boolean {
  try {
    return writeVaultDraftRecord(window.localStorage, draftKey(root, path), content, metadata);
  } catch { return false; }
}

function sortedEntries(entries: readonly VaultEntry[]): VaultEntry[] {
  return [...entries].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
}

function frontmatterStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
}

function frontmatterTitle(frontmatter: Record<string, unknown> | undefined, path: string): string {
  const sourceTitle = frontmatter?.sourceTitle;
  const title = frontmatter?.title;
  return (typeof sourceTitle === 'string' && sourceTitle.trim() !== '' ? sourceTitle.trim()
    : typeof title === 'string' && title.trim() !== '' ? title.trim()
      : basename(path));
}

function relatedSourceDocuments(snapshot: VaultSnapshot, currentPath: string | null, frontmatter: Record<string, unknown> | null): RelatedSourceDocument[] {
  if (currentPath === null || frontmatter === null) return [];
  const sourceIds = new Set(frontmatterStrings(frontmatter.sourceIds));
  if (sourceIds.size === 0) return [];
  return snapshot.files.flatMap((entry) => {
    if (entry.kind !== 'file' || entry.path === currentPath || entry.frontmatter?.noteType !== 'source') return [];
    const sourceId = frontmatterStrings(entry.frontmatter.sourceIds).find((id) => sourceIds.has(id));
    return sourceId === undefined ? [] : [{ path: entry.path, sourceId, title: frontmatterTitle(entry.frontmatter, entry.path) }];
  });
}

function vaultChangeKey(rootPath: string, path: string): string { return `${rootPath}\0${path}`; }

function headingSlug(value: string): string {
  return value.toLocaleLowerCase().normalize('NFC').replace(/[\p{P}\p{S}]+/gu, '').trim().replace(/\s+/g, '-');
}

interface PreparedMarkdownSection {
  tokens: any[];
  startLine: number | null;
  endLine: number | null;
  footnotes: boolean;
  footnoteRefIds: string[];
}

interface PreparedMarkdown {
  sections: PreparedMarkdownSection[];
  renderTokens: (tokens: any[], trustMermaid: boolean) => string;
}

function markdownRuntime(): Promise<{
  render: (source: string, trustedHtml: boolean, trustMermaid: boolean, sourcePath?: string) => string;
  prepare: (source: string, trustedHtml: boolean, sourcePath: string, docId: string) => PreparedMarkdown;
  sanitize: (html: string) => string;
}> {
  if (markdownRuntimePromise === null) {
    markdownRuntimePromise = Promise.all([
      import('markdown-it'), import('markdown-it-footnote'), import('markdown-it-katex'), import('dompurify'), import('highlight.js/lib/common'),
    ]).then(([markdownModule, footnoteModule, katexModule, purifierModule, highlightModule]) => {
      const MarkdownIt = markdownModule.default;
      const footnote = footnoteModule.default;
      const katex = katexModule.default;
      const purifier = purifierModule.default;
      const highlighter = highlightModule.default;
      const esc = (value: string): string => MarkdownIt().utils.escapeHtml(value);
      const create = (allowHtml: boolean) => {
        const md = new MarkdownIt({
          html: allowHtml,
          linkify: true,
          breaks: false,
          typographer: false,
          highlight(code: string, language: string) {
            try {
              return language && highlighter.getLanguage(language)
                ? highlighter.highlight(code, { language }).value
                : highlighter.highlightAuto(code).value;
            } catch { return esc(code); }
          },
        });
        md.use(footnote).use(katex);
        md.inline.ruler.before('link', 'noltri_wikilink', (state: any, silent: boolean) => {
          const start = state.pos as number;
          const source = state.src as string;
          const embed = source.startsWith('![[', start);
          const open = embed ? start + 1 : start;
          if (!source.startsWith('[[', open)) return false;
          const close = source.indexOf(']]', open + 2);
          if (close < 0) return false;
          if (silent) return true;
          const raw = source.slice(open + 2, close);
      const [target = '', ...aliasParts] = raw.split('|');
          const token = state.push(embed ? 'noltri_embed' : 'noltri_wikilink', embed ? 'div' : 'a', 0);
          token.meta = { target: target.trim(), label: aliasParts.join('|').trim() || basename(target.trim()) || target.trim() };
          token.content = token.meta.label;
          state.pos = close + 2;
          return true;
        });
        md.renderer.rules.noltri_wikilink = (tokens: any[], index: number, _options: any, env: any) => {
          const meta = tokens[index]!.meta as { target: string; label: string };
          const sourceAttr = env?.sourcePath ? ` data-noltri-source-path="${esc(String(env.sourcePath))}"` : '';
          return `<a href="#" data-noltri-wikilink="${esc(meta.target)}"${sourceAttr}>${esc(meta.label)}</a>`;
        };
        md.renderer.rules.noltri_embed = (tokens: any[], index: number) => {
          const meta = tokens[index]!.meta as { target: string; label: string };
          return `<div class="vault-embed" data-noltri-embed="${esc(meta.target)}"><span>嵌入：${esc(meta.label)}</span></div>`;
        };
        md.core.ruler.after('inline', 'noltri_blockid', (state: any) => {
          for (let index = 0; index < state.tokens.length - 1; index += 1) {
            const block = state.tokens[index];
            const inline = state.tokens[index + 1];
            if (block.type !== 'paragraph_open' || inline.type !== 'inline') continue;
            const match = inline.content.match(/\s+\^([\p{L}\p{N}_-]+)\s*$/u);
            if (match === null) continue;
            const id = match[1] as string;
            block.attrSet('data-block-id', id);
            inline.content = inline.content.slice(0, match.index).trimEnd();
            const last = inline.children?.at(-1);
            if (last?.type === 'text') {
              last.content = last.content.replace(/\s+\^[\p{L}\p{N}_-]+\s*$/u, '').trimEnd();
              if (last.content === '') inline.children.pop();
            }
          }
        });
        const originalHeading = md.renderer.rules.heading_open ?? ((tokens: any[], index: number, options: any, env: any, renderer: any) => renderer.renderToken(tokens, index, options));
        md.renderer.rules.heading_open = (tokens: any[], index: number, options: any, env: any, renderer: any) => {
          const heading = tokens[index + 1]?.content ?? '';
          tokens[index]!.attrSet('id', headingSlug(heading));
          tokens[index]!.attrSet('tabindex', '-1');
          const sourceLine = tokens[index]!.map?.[0];
          if (sourceLine !== undefined) tokens[index]!.attrSet('data-source-line', String(sourceLine));
          return originalHeading(tokens, index, options, env, renderer);
        };
        const originalFence = md.renderer.rules.fence;
        md.renderer.rules.fence = (tokens: any[], index: number, options: any, env: any, renderer: any) => {
          const token = tokens[index]!;
          if (token.info.trim().split(/\s+/)[0]?.toLocaleLowerCase() === 'mermaid') {
            const code = esc(token.content);
            return `<div class="vault-mermaid" data-mermaid-source="${esc(token.content)}">${code}</div>`;
          }
          return originalFence?.(tokens, index, options, env, renderer) ?? `<pre><code>${esc(token.content)}</code></pre>`;
        };
        md.renderer.rules.image = (tokens: any[], index: number) => {
          const token = tokens[index]!;
          const source = token.attrGet('src') ?? '';
          const alt = esc(token.content || '');
          const title = token.attrGet('title');
          const titleAttr = title ? ` title="${esc(title)}"` : '';
          if (safeNoteHref(source) === null) return `<span class="vault-blocked-image">已阻止不安全图片链接：${alt}</span>`;
          if (/^https?:/i.test(source)) return `<img alt="${alt}"${titleAttr} data-noltri-external-image="${esc(source)}" />`;
          return `<img alt="${alt}"${titleAttr} data-noltri-asset="${esc(source)}" />`;
        };
        const originalLink = md.renderer.rules.link_open ?? ((tokens: any[], index: number, options: any, env: any, renderer: any) => renderer.renderToken(tokens, index, options));
        md.renderer.rules.link_open = (tokens: any[], index: number, options: any, env: any, renderer: any) => {
          const href = tokens[index]!.attrGet('href') ?? '';
          if (safeNoteHref(href) === null) return '';
          if (/^https?:/i.test(href)) tokens[index]!.attrSet('rel', 'noopener noreferrer');
          if (env?.sourcePath) tokens[index]!.attrSet('data-noltri-source-path', String(env.sourcePath));
          return originalLink(tokens, index, options, env, renderer);
        };
        return md;
      };
      const renderTokens = (md: any, tokens: any[], env: Record<string, unknown>, trustMermaid: boolean): string => {
          const originalFence = md.renderer.rules.fence;
          md.renderer.rules.fence = (tokens: any[], index: number, options: any, env: any, renderer: any) => {
            const token = tokens[index]!;
            if (token.info.trim().split(/\s+/)[0]?.toLocaleLowerCase() === 'mermaid' && !trustMermaid) {
              const code = md.utils.escapeHtml(token.content);
              return `<pre class="vault-mermaid-block"><code>${code}</code><button type="button" data-noltri-trust-mermaid>信任此笔记库并渲染 Mermaid</button></pre>`;
            }
            return originalFence?.(tokens, index, options, env, renderer) ?? '';
          };
          try { return md.renderer.render(tokens, md.options, env); }
          finally { md.renderer.rules.fence = originalFence; }
      };
      return {
        render(source, trustedHtml, trustMermaid, sourcePath) {
          const md = create(trustedHtml);
          const env: Record<string, unknown> = { sourcePath };
          return renderTokens(md, md.parse(source, env), env, trustMermaid);
        },
        prepare(source, trustedHtml, sourcePath, docId) {
          const md = create(trustedHtml);
          const env: Record<string, unknown> = { sourcePath, docId };
          const tokens = md.parse(source, env);
          const sections = groupMarkdownTokens(tokens).map((group) => {
            const footnoteRefIds: string[] = [];
            for (const token of group.tokens) {
              if (token.type !== 'inline') continue;
              for (const child of token.children ?? []) {
                if (child.type !== 'footnote_ref' || child.meta === null || child.meta === undefined) continue;
                const id = Number(child.meta.id);
                const subId = Number(child.meta.subId ?? 0);
                if (!Number.isInteger(id) || id < 0 || !Number.isInteger(subId) || subId < 0) continue;
                footnoteRefIds.push(`fnref-${docId}-${id + 1}${subId > 0 ? `:${subId}` : ''}`);
              }
            }
            return { ...group, footnoteRefIds };
          });
          return {
            sections,
            renderTokens: (sectionTokens, trustMermaid) => renderTokens(md, sectionTokens, env, trustMermaid),
          };
        },
        sanitize(html) {
          const clean = purifier.sanitize(html, { FORBID_TAGS: ['script', 'iframe', 'object', 'embed'], ADD_ATTR: ['data-noltri-wikilink', 'data-noltri-embed', 'data-noltri-trust-mermaid', 'data-mermaid-source', 'data-noltri-external-image', 'data-noltri-asset', 'data-noltri-source-path', 'data-block-id', 'data-source-line'] }) as string;
          const template = document.createElement('template');
          template.innerHTML = clean;
          for (const image of template.content.querySelectorAll<HTMLImageElement>('img[src]')) {
            const source = image.getAttribute('src') ?? '';
            image.removeAttribute('src');
            if (safeNoteHref(source) === null) continue;
            if (/^https?:/i.test(source)) image.dataset.noltriExternalImage = source;
            else if (source !== '') image.dataset.noltriAsset = source;
          }
          return template.innerHTML;
        },
      };
    });
  }
  return markdownRuntimePromise;
}

let markdownRuntimePromise: ReturnType<typeof markdownRuntime> | null = null;

function MarkdownSection({ source, trustedHtml, trustMermaid, api, sourcePath, onOpenLink, onTrustMermaid, onHoverLink, onLeaveLink, preparedTokens, renderTokens, readerId, sectionIndex, footnotes, footnoteRefIds, onNavigateFootnote, forceRender = false }: {
  source: string; trustedHtml: boolean; trustMermaid: boolean; api: WorkbenchApi; sourcePath: string;
  onOpenLink: (target: string, sourcePath?: string, kind?: VaultLinkKind) => void; onTrustMermaid: () => void;
  onHoverLink?: (target: string, anchor: DOMRect, sourcePath?: string, kind?: VaultLinkKind) => void; onLeaveLink?: () => void;
  preparedTokens?: any[]; renderTokens?: (tokens: any[], trustMermaid: boolean) => string; readerId?: string; sectionIndex?: number;
  footnotes?: boolean; footnoteRefIds?: string[]; onNavigateFootnote?: (id: string) => void; forceRender?: boolean;
}): ReactElement {
  const [html, setHtml] = useState('');
  const [ready, setReady] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const holderRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (element === null) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setReady(true); observer.disconnect(); }
    }, { rootMargin: '700px 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => { if (forceRender) setReady(true); }, [forceRender]);

  useEffect(() => {
    let cancelled = false;
    if (!ready) return undefined;
    void markdownRuntime().then((runtime) => {
      const html = preparedTokens !== undefined && renderTokens !== undefined
        ? renderTokens(preparedTokens, trustMermaid)
        : runtime.render(source, trustedHtml, trustMermaid, sourcePath);
      if (!cancelled) setHtml(runtime.sanitize(html));
    });
    return () => { cancelled = true; };
  }, [ready, source, trustedHtml, trustMermaid, sourcePath, preparedTokens, renderTokens]);

  useEffect(() => {
    const holder = holderRef.current;
    if (holder === null || html === '') return;
    const click = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const wiki = target.closest<HTMLElement>('[data-noltri-wikilink]');
      if (wiki !== null) { event.preventDefault(); onOpenLink(wiki.dataset.noltriWikilink ?? '', wiki.dataset.noltriSourcePath ?? sourcePath, 'wikilink'); return; }
      if (target.closest('[data-noltri-trust-mermaid]') !== null) { event.preventDefault(); onTrustMermaid(); return; }
      const externalImage = target.closest<HTMLImageElement>('img[data-noltri-external-image]');
      if (externalImage !== null) {
        const source = externalImage.dataset.noltriExternalImage ?? '';
        event.preventDefault();
        if (/^https?:\/\//i.test(source) && safeNoteHref(source) !== null && window.confirm(`即将从外部加载图片：\n${source}\n\n是否继续？`)) { externalImage.src = source; delete externalImage.dataset.noltriExternalImage; }
        return;
      }
      const anchor = target.closest<HTMLAnchorElement>('a[href]');
      if (anchor === null) return;
      const href = anchor.getAttribute('href') ?? '';
      if (safeNoteHref(href) === null) { event.preventDefault(); return; }
      if (/^https?:/i.test(href)) {
        event.preventDefault();
        if (window.confirm(`即将打开外部链接：\n${href}\n\n是否继续？`)) window.open(href, '_blank', 'noopener,noreferrer');
      } else if (/^mailto:/i.test(href)) {
        event.preventDefault();
        if (window.confirm(`即将打开邮件链接：\n${href}\n\n是否继续？`)) window.location.href = href;
      } else if (href.startsWith('#')) {
        event.preventDefault();
        const fragment = safeDecodeVaultFragment(href.slice(1));
        const scopedFootnote = fragment !== null && readerId !== undefined
          && (fragment.startsWith(`fn-${readerId}-`) || fragment.startsWith(`fnref-${readerId}-`));
        if (fragment !== null && (scopedFootnote || /^(?:fn\d+|fnref\d+(?::\d+)?)$/i.test(fragment))) {
          if (scopedFootnote && onNavigateFootnote !== undefined) { onNavigateFootnote(fragment); return; }
          const reader = holder.closest('.vault-reader-scroll') ?? holder;
          [...reader.querySelectorAll<HTMLElement>('[id]')].find((element) => element.id === fragment)
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else onOpenLink(href, anchor.dataset.noltriSourcePath ?? sourcePath, 'markdown');
      } else if (href !== '') { event.preventDefault(); onOpenLink(href, anchor.dataset.noltriSourcePath ?? sourcePath, 'markdown'); }
    };
    const pointerover = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest<HTMLAnchorElement>('[data-noltri-wikilink], a[href]');
      if (link === null || link.matches('[data-noltri-external-image]')) return;
      if (event.relatedTarget instanceof Node && link.contains(event.relatedTarget)) return;
      const href = link.dataset.noltriWikilink ?? link.getAttribute('href') ?? '';
      if (href === '' || href === '#' || /^https?:|^mailto:/i.test(href) || safeNoteHref(href) === null) return;
      onHoverLink?.(href, link.getBoundingClientRect(), link.dataset.noltriSourcePath ?? sourcePath, link.dataset.noltriWikilink === undefined ? 'markdown' : 'wikilink');
    };
    const pointerout = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest<HTMLAnchorElement>('[data-noltri-wikilink], a[href]');
      if (link === null || (event.relatedTarget instanceof Node && link.contains(event.relatedTarget))) return;
      onLeaveLink?.();
    };
    holder.addEventListener('click', click);
    holder.addEventListener('pointerover', pointerover);
    holder.addEventListener('pointerout', pointerout);
    return () => { holder.removeEventListener('click', click); holder.removeEventListener('pointerover', pointerover); holder.removeEventListener('pointerout', pointerout); };
  }, [html, onOpenLink, onTrustMermaid, onHoverLink, onLeaveLink, sourcePath, readerId, onNavigateFootnote]);

  useEffect(() => {
    const holder = holderRef.current;
    if (holder === null || html === '') return;
    let cancelled = false;
    const loadAssets = async (container: ParentNode, relativeTo: string): Promise<void> => {
      const images = [...container.querySelectorAll<HTMLImageElement>('img[data-noltri-asset]')];
      await Promise.all(images.map(async (image) => {
        const target = image.dataset.noltriAsset ?? '';
        try {
          const resolved = await api.resolveVaultLink(target, relativeTo, 'markdown');
          if (cancelled || resolved.path === null) { image.classList.add('vault-asset-missing'); return; }
          const asset = await api.getVaultAsset(resolved.path);
          if (cancelled) return;
          image.src = asset.dataUrl;
          delete image.dataset.noltriAsset;
        } catch { if (!cancelled) image.classList.add('vault-asset-missing'); }
      }));
    };
    const expandEmbeds = async (container: ParentNode, relativeTo: string, depth: number): Promise<void> => {
      const embeds = [...container.querySelectorAll<HTMLElement>('[data-noltri-embed]')];
      await Promise.all(embeds.map(async (embed) => {
        const raw = embed.dataset.noltriEmbed ?? '';
        const marker = raw.indexOf('#');
        const target = marker < 0 ? raw : raw.slice(0, marker);
        const subpath = marker < 0 ? '' : raw.slice(marker + 1);
        try {
          const resolved = await api.resolveVaultLink(target, relativeTo, 'wikilink');
          if (cancelled || resolved.path === null) { embed.classList.add('vault-embed-missing'); return; }
          if (/\.md$/i.test(resolved.path)) {
            if (depth >= 3) { embed.textContent = '嵌入层级超过 3 层'; embed.classList.add('vault-embed-depth-limit'); return; }
            const file = await api.vaultFile(resolved.path);
            const runtime = await markdownRuntime();
            const selected = subpath ? extractSubpath(file.content, subpath) ?? file.content : file.content;
            if (cancelled) return;
            embed.innerHTML = runtime.sanitize(runtime.render(selected, trustedHtml, trustMermaid, resolved.path));
            embed.classList.add('vault-embed-loaded');
            for (const link of embed.querySelectorAll<HTMLElement>('[data-noltri-wikilink]')) link.dataset.noltriSourcePath = resolved.path;
            await loadAssets(embed, resolved.path);
            await expandEmbeds(embed, resolved.path, depth + 1);
          } else {
            const asset = await api.getVaultAsset(resolved.path);
            if (cancelled) return;
            const media = asset.mimeType.startsWith('image/') ? document.createElement('img')
              : asset.mimeType.startsWith('audio/') ? document.createElement('audio')
                : asset.mimeType.startsWith('video/') ? document.createElement('video') : document.createElement('a');
            if (media instanceof HTMLAnchorElement) { media.href = asset.dataUrl; media.textContent = resolved.path; media.download = resolved.path.split('/').at(-1) ?? '附件'; }
            else { media.src = asset.dataUrl; media.setAttribute('controls', ''); media.className = 'vault-embedded-media'; }
            embed.replaceChildren(media);
            embed.classList.add('vault-embed-loaded');
          }
          embed.removeAttribute('data-noltri-embed');
        } catch { if (!cancelled) embed.classList.add('vault-embed-missing'); }
      }));
    };
    void (async () => { await loadAssets(holder, sourcePath); await expandEmbeds(holder, sourcePath, 0); })();
    return () => { cancelled = true; };
  }, [api, html, sourcePath, trustedHtml, trustMermaid]);

  useEffect(() => {
    const holder = holderRef.current;
    if (!trustMermaid || holder === null || !holder.querySelector('[data-mermaid-source]')) return;
    let cancelled = false;
    void import('mermaid').then(({ default: mermaid }) => {
      if (cancelled || holderRef.current === null) return;
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral' });
      return mermaid.run({ nodes: holder.querySelectorAll<HTMLElement>('[data-mermaid-source]:not([data-rendered])') }).then(() => {
        for (const node of holder.querySelectorAll<HTMLElement>('[data-mermaid-source]')) node.dataset.rendered = 'true';
      });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [html, trustMermaid]);

  return <div ref={containerRef} className="vault-reader-section" data-vault-section-index={sectionIndex}
    data-vault-footnotes={footnotes ? 'true' : undefined} data-vault-footnote-ref-ids={footnoteRefIds?.join(' ')}>
    {!ready ? <div className="vault-reader-placeholder" aria-hidden="true" /> : <div ref={holderRef} className="vault-reader-markdown" dangerouslySetInnerHTML={{ __html: html }} />}
  </div>;
}

type ReaderJumpTarget = string | { subpath: string; sourceOffset?: number };

interface ReaderPreparedMarkdown extends PreparedMarkdown {
  source: string;
  sourcePath: string;
  trustedHtml: boolean;
}

function noteBody(content: string): string {
  return content.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, '');
}

const graphNoteSystemProperties = new Set(['id', 'noteType', 'topicId', 'chapterId', 'title']);

function graphNoteProperties(content: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(content);
  if (match === null) {
    if (content.startsWith('---\n') || content.startsWith('---\r\n')) throw new Error('笔记属性 YAML 无法解析；修复语法后再保存。');
    return {};
  }
  let parsed: unknown;
  try { parsed = YAML.parse(match[1] ?? ''); }
  catch { throw new Error('笔记属性 YAML 无法解析；修复语法后再保存。'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('笔记属性必须是 YAML 对象。');
  return Object.fromEntries(Object.entries(parsed).filter(([key]) => !graphNoteSystemProperties.has(key)));
}

function sameProperties(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function NoteReader({ content, path, api, trustedHtml, trustMermaid, onOpenLink, onTrustMermaid, onHoverLink, onLeaveLink, jumpTo }: {
  content: string; path: string; api: WorkbenchApi; trustedHtml: boolean; trustMermaid: boolean;
  onOpenLink: (target: string, sourcePath?: string, kind?: VaultLinkKind) => void; onTrustMermaid: () => void;
  onHoverLink?: (target: string, anchor: DOMRect, sourcePath?: string, kind?: VaultLinkKind) => void; onLeaveLink?: () => void; jumpTo?: ReaderJumpTarget | null;
}): ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const readerId = useId().replace(/[^A-Za-z0-9_-]/g, '-');
  const body = useMemo(() => noteBody(content), [content]);
  const blocks = useMemo(() => markdownBlockRanges(body), [body]);
  const footnoteJumpSequence = useRef(0);
  const [forcedSectionIndex, setForcedSectionIndex] = useState<number | null>(null);
  const [prepared, setPrepared] = useState<ReaderPreparedMarkdown | null>(null);
  const hasFootnoteSyntax = /\[\^[^\]\s]+\]/u.test(body);
  useEffect(() => {
    let cancelled = false;
    setPrepared(null);
    if (!hasFootnoteSyntax) return () => { cancelled = true; };
    void markdownRuntime().then((runtime) => {
      if (cancelled) return;
      setPrepared({ ...runtime.prepare(body, trustedHtml, path, readerId), source: body, sourcePath: path, trustedHtml });
    });
    return () => { cancelled = true; };
  }, [body, hasFootnoteSyntax, path, readerId, trustedHtml]);
  const preparedReader = prepared?.source === body && prepared.sourcePath === path && prepared.trustedHtml === trustedHtml
    ? prepared : null;
  useEffect(() => {
    footnoteJumpSequence.current += 1;
    setForcedSectionIndex(null);
    return () => { footnoteJumpSequence.current += 1; };
  }, [body, path]);
  const onNavigateFootnote = useCallback((id: string): void => {
    if (preparedReader === null) return;
    const reader = scrollRef.current;
    if (reader === null) return;
    const sectionIndex = id.startsWith(`fnref-${readerId}-`)
      ? preparedReader.sections.findIndex((section) => section.footnoteRefIds.includes(id))
      : id.startsWith(`fn-${readerId}-`)
        ? preparedReader.sections.findIndex((section) => section.footnotes)
        : -1;
    if (sectionIndex < 0) return;
    const section = reader.querySelector<HTMLElement>(`[data-vault-section-index="${sectionIndex}"]`);
    if (section === null) return;
    const jumpSequence = ++footnoteJumpSequence.current;
    setForcedSectionIndex(sectionIndex);
    section.scrollIntoView({ behavior: 'auto', block: 'start' });
    let attempts = 0;
    let visiblePasses = 0;
    const reveal = (): void => {
      if (jumpSequence !== footnoteJumpSequence.current || scrollRef.current !== reader) return;
      const target = [...section.querySelectorAll<HTMLElement>('[id]')].find((element) => element.id === id);
      const readerBounds = reader.getBoundingClientRect();
      if (target !== undefined) {
        const bounds = target.getBoundingClientRect();
        if (bounds.top < readerBounds.top || bounds.bottom > readerBounds.bottom) {
          visiblePasses = 0;
          target.scrollIntoView({ behavior: 'auto', block: 'center' });
        } else if (++visiblePasses >= 3) return;
      } else {
        visiblePasses = 0;
        const sectionBounds = section.getBoundingClientRect();
        if (sectionBounds.bottom < readerBounds.top - 700 || sectionBounds.top > readerBounds.bottom + 700) {
          section.scrollIntoView({ behavior: 'auto', block: 'center' });
        }
      }
      attempts += 1;
      if (attempts < 60) window.setTimeout(reveal, 40);
    };
    window.setTimeout(reveal, 40);
  }, [preparedReader, readerId]);
  useEffect(() => {
    if (!jumpTo) return;
    let cancelled = false;
    let attempts = 0;
    const target = typeof jumpTo === 'string' ? { subpath: jumpTo } : jumpTo;
    void (async () => {
      const scrollToFileStart = (): void => scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
      let position: number | undefined = target.sourceOffset;
      if (position === undefined) {
        try { position = (await api.vaultSubpath(path, target.subpath.replace(/^#/, ''))).position?.start.offset; }
        catch { return; }
      }
      if (cancelled) return;
      if (position === undefined) {
        scrollToFileStart();
        return;
      }
      let readerTarget: { sectionIndex: number; sourceLine: number } | null;
      if (preparedReader !== null) {
        const bodyOffset = content.length - body.length;
        const offset = position - bodyOffset;
        if (!Number.isInteger(offset) || offset < 0 || offset > body.length) { scrollToFileStart(); return; }
        const sourceLine = body.slice(0, offset).split(/\r?\n/).length - 1;
        const sectionIndex = preparedReader.sections.findIndex((section) => section.startLine !== null && section.endLine !== null
          && sourceLine >= section.startLine && sourceLine < section.endLine);
        readerTarget = sectionIndex < 0 ? null : { sectionIndex, sourceLine };
      } else readerTarget = markdownReaderTarget(content, position);
      if (readerTarget === null) { scrollToFileStart(); return; }
      const section = scrollRef.current?.querySelectorAll<HTMLElement>('.vault-reader-section')[readerTarget.sectionIndex] ?? null;
      if (section === null) { scrollToFileStart(); return; }
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const reveal = (): void => {
      if (cancelled) return;
      const holder = section.querySelector<HTMLElement>('.vault-reader-markdown');
      const decodedBlockSubpath = safeDecodeVaultFragment(target.subpath.replace(/^#/, ''));
      const blockId = decodedBlockSubpath?.match(/^\^(.+)$/)?.[1];
      const anchor = blockId === undefined
        ? [...(holder?.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6') ?? [])].find((heading) => Number(heading.dataset.sourceLine) === readerTarget.sourceLine)
        : [...(holder?.querySelectorAll<HTMLElement>('[data-block-id]') ?? [])].find((node) => node.dataset.blockId?.toLocaleLowerCase() === blockId.toLocaleLowerCase());
      if (anchor !== undefined && anchor !== null) { anchor.scrollIntoView({ behavior: 'smooth', block: 'start' }); anchor.focus({ preventScroll: true }); return; }
      attempts += 1;
        if (attempts < 40) window.setTimeout(reveal, 40);
      };
      window.setTimeout(reveal, 120);
    })();
    return () => { cancelled = true; };
  }, [api, body, content, jumpTo, path, preparedReader]);
  const sections = preparedReader?.sections ?? null;
  return <div ref={scrollRef} className="vault-reader-scroll" tabIndex={-1}>
    {sections !== null
      ? sections.map((section, index) => <MarkdownSection key={`${path}:${readerId}:${index}`} source="" preparedTokens={section.tokens}
        renderTokens={preparedReader?.renderTokens} readerId={readerId} sectionIndex={index} footnotes={section.footnotes}
        footnoteRefIds={section.footnoteRefIds} onNavigateFootnote={onNavigateFootnote} forceRender={forcedSectionIndex === index} trustedHtml={trustedHtml} trustMermaid={trustMermaid}
        api={api} sourcePath={path} onOpenLink={onOpenLink} onTrustMermaid={onTrustMermaid} onHoverLink={onHoverLink} onLeaveLink={onLeaveLink} />)
      : blocks.map((block, index) => <MarkdownSection key={`${path}:${index}`} source={block.source} sectionIndex={index}
        trustedHtml={trustedHtml} trustMermaid={trustMermaid} api={api} sourcePath={path} onOpenLink={onOpenLink}
        onTrustMermaid={onTrustMermaid} onHoverLink={onHoverLink} onLeaveLink={onLeaveLink} />)}
  </div>;
}

export function WorkbenchNotes({ api, active, displayMode = 'editor', contentView, requestedOpen, scopePaths, scopeTitle, libraryView, previewRequest = null, assetRequest = null, tagQuery, vaultTagCounts, onContextChange, onVaultDocumentsChanged, onVaultEntriesChange, onRegisterFlushHandler, onRightPanelContentChange, onLegacyDraftSaved, onUpdateSafetyChange, commandRequestId = 0, searchQuery: workspaceSearchQuery = '', onRequestToolChange, onSearchRequest, onNavigateRequest }: WorkbenchNotesProps): ReactElement {
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [tabs, setTabs] = useState<string[]>([]);
  const [splitNote, setSplitNote] = useState<NoteFile | null>(null);
  const [note, setNote] = useState<NoteFile | null>(null);
  const [content, setContent] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [transitioning, setTransitioning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<EditorMode>('live');
  const [metadata, setMetadata] = useState<CachedNoteMetadata | null>(null);
  const [backlinks, setBacklinks] = useState<Awaited<ReturnType<WorkbenchApi['vaultBacklinks']>>['backlinks']>([]);
  const [mentions, setMentions] = useState<Awaited<ReturnType<WorkbenchApi['vaultMentions']>>['mentions']>([]);
  const [history, setHistory] = useState<NoteHistoryResponse['versions']>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [search, setSearch] = useState<NoteSearchResponse | null>(null);
  const [switcherQuery, setSwitcherQuery] = useState('');
  const [switcherResults, setSwitcherResults] = useState<NoteSearchResponse['results']>([]);
  const [recentCommandIds, setRecentCommandIds] = useState<string[]>([]);
  const [commandOpen, setCommandOpen] = useState(false);
  const [newNoteOpen, setNewNoteOpen] = useState(false);
  const [newNotePath, setNewNotePath] = useState('');
  const [deletedPaths, setDeletedPaths] = useState<string[]>([]);
  const [showDeletedHistory, setShowDeletedHistory] = useState(false);
  const [restorePath, setRestorePath] = useState<string | null>(null);
  const [renamePath, setRenamePath] = useState('');
  const [outlineCursor, setOutlineCursor] = useState(0);
  const [trust, setTrust] = useState<TrustSettings>({ html: false, mermaid: false });
  const [vaultSettings, setVaultSettings] = useState<VaultSettings>({ newLinkFormat: 'shortest', propertyTypes: {} });
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [draftAvailable, setDraftAvailable] = useState(false);
  const [propertySafeForUpdate, setPropertySafeForUpdate] = useState(true);
  const reportPropertyUpdateSafety = useCallback((safe: boolean): void => { setPropertySafeForUpdate(safe); }, []);
  const [interpretationSafeForUpdate, setInterpretationSafeForUpdate] = useState(true);
  const handleInterpretationUpdateSafety = useCallback((safe: boolean): void => { setInterpretationSafeForUpdate(safe); }, []);
  useEffect(() => {
    onUpdateSafetyChange?.(propertySafeForUpdate && interpretationSafeForUpdate && saveState === 'saved' && !transitioning && !settingsBusy && !draftAvailable && !newNoteOpen && renamePath === '' && error === null);
  }, [propertySafeForUpdate, interpretationSafeForUpdate, saveState, transitioning, settingsBusy, draftAvailable, newNoteOpen, renamePath, error, onUpdateSafetyChange]);
  const [jumpTo, setJumpTo] = useState<ReaderJumpTarget | null>(null);
  const [editorJumpRequest, setEditorJumpRequest] = useState<{ path: string; requestId: number; sourceOffset: number } | null>(null);
  const [previewTarget, setPreviewTarget] = useState<{ path: string; title: string; content: string; anchor: DOMRect } | null>(null);
  const [assetPreview, setAssetPreview] = useState<{ path: string; mimeType: string; dataUrl: string } | null>(null);
  const [localScopePaths, setLocalScopePaths] = useState<Set<string>>(() => new Set());
  const saveTimer = useRef<number | null>(null);
  const revisionRef = useRef(0);
  const metadataRevisionRef = useRef(-1);
  const backlinksRevisionRef = useRef(-1);
  const mentionsRevisionRef = useRef(-1);
  const noteRef = useRef<NoteFile | null>(null);
  const semanticIdentityByPathRef = useRef(new Map<string, SemanticNoteIdentity>());
  const semanticIdentityRootRef = useRef<string | null>(null);
  const contentRef = useRef(content);
  const rootPathRef = useRef<string | null>(snapshot?.rootPath ?? null);
  const vaultEpochRef = useRef(0);
  const noteOwnerRef = useRef<LoadedNoteOwner | null>(null);
  const noteContentColumnRef = useRef<HTMLElement | null>(null);
  const returnToTextRef = useRef<() => void>(() => undefined);
  const noteOwnerIdRef = useRef(0);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  const draftWritesRef = useRef<ReturnType<typeof createVaultDraftWriteQueue> | null>(null);
  if (draftWritesRef.current === null) draftWritesRef.current = createVaultDraftWriteQueue(
    setDraft,
    750,
    (root, path, metadata) => {
      if (!mountedRef.current || rootPathRef.current !== root || noteRef.current?.path !== path) return;
      setError(metadata?.conflict
        ? '本机恢复草稿写入失败；当前存在外部冲突且不会自动覆盖磁盘。请立即复制当前内容。'
        : '本机恢复草稿未能写入或清除；笔记保存状态见上方（非冲突时自动保存仍可继续）。请复制重要内容。');
    },
  );
  const pendingWritesRef = useRef(new Map<string, number>());
  const deferredChangesRef = useRef(new Set<string>());
  const changesPollInFlightRef = useRef(false);
  const vaultSettingsRef = useRef(vaultSettings);
  const settingsRootRef = useRef<string | null>(null);
  const settingsWriteChainRef = useRef<Promise<void>>(Promise.resolve());
  const settingsWritesByRootRef = useRef(new Map<string, number>());
  const contextPathRef = useRef<string | null>(null);
  const mentionsPathRef = useRef<string | null>(null);
  const previewTimer = useRef<number | null>(null);
  const previewOpenTimer = useRef<number | null>(null);
  const modifierHeld = useRef(false);
  const lastCommandRequestId = useRef(0);
  const lastOpenRequestId = useRef<number | null>(null);
  const legacyDraftRef = useRef<{ path: string; draft: { topicId: string; chapterId: string | null; content: string } } | null>(null);
  const noteLoadRequestId = useRef(0);
  const editorJumpRequestId = useRef(0);
  const splitLoadRequestId = useRef(0);
  const transitionCountRef = useRef(0);
  const mentionWritesRef = useRef(new Set<Promise<void>>());
  noteRef.current = note;
  rootPathRef.current = snapshot?.rootPath ?? null;

  const captureVaultContext = useCallback((): VaultContextIdentity | null => {
    const rootPath = rootPathRef.current;
    return rootPath === null ? null : { rootPath, epoch: vaultEpochRef.current };
  }, []);
  const ownsVaultContext = useCallback((identity: VaultContextIdentity | null): identity is VaultContextIdentity =>
    identity !== null && vaultContextMatches(identity, rootPathRef.current, vaultEpochRef.current), []);
  const ownsNoteContext = useCallback((identity: VaultContextIdentity | null, path: string, ownerId?: number): boolean => {
    const owner = noteOwnerRef.current;
    return ownsVaultContext(identity) && owner !== null && owner.rootPath === identity.rootPath
      && owner.epoch === identity.epoch && owner.path === path && (ownerId === undefined || owner.id === ownerId)
      && noteRef.current?.path === path;
  }, [ownsVaultContext]);
  const bindLoadedNote = useCallback((file: NoteFile, identity: VaultContextIdentity): number => {
    const id = ++noteOwnerIdRef.current;
    noteOwnerRef.current = { ...identity, path: file.path, id };
    noteRef.current = file;
    setNote(file);
    return id;
  }, []);
  const updateLoadedNote = useCallback((file: NoteFile, identity: VaultContextIdentity, ownerId?: number): boolean => {
    if (!ownsNoteContext(identity, file.path, ownerId)) return false;
    noteRef.current = file;
    setNote(file);
    return true;
  }, [ownsNoteContext]);
  const clearLoadedNote = useCallback((): void => {
    noteOwnerRef.current = null;
    noteRef.current = null;
    setNote(null);
  }, []);

  const beginTransition = useCallback((): (() => void) => {
    transitionCountRef.current += 1;
    setTransitioning(true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      transitionCountRef.current = Math.max(0, transitionCountRef.current - 1);
      setTransitioning(transitionCountRef.current > 0);
    };
  }, []);

  const returnFocusToSource = (): void => {
    const column = noteContentColumnRef.current;
    if (column === null) return;
    const selector = mode === 'read' ? '.vault-reader-scroll' : '.cm-content[contenteditable="true"]';
    const source = column.querySelector<HTMLElement>(selector);
    source?.focus({ preventScroll: true });
    if (source === null || document.activeElement !== source) column.focus({ preventScroll: true });
  };

  const commitContent = useCallback((value: string): void => {
    contentRef.current = value;
    setContent(value);
  }, []);
  const hasUnsavedContent = useCallback((path = noteRef.current?.path): boolean => {
    const current = noteRef.current;
    return path !== undefined && current?.path === path && contentRef.current !== current.content;
  }, []);

  const publishContext = useCallback((next: VaultSnapshot | null, path: string | null, frontmatter: Record<string, unknown> | null = null): void => {
    if (next !== null) onContextChange(next.rootPath, path, next.revision, frontmatter, relatedSourceDocuments(next, path, frontmatter));
  }, [onContextChange]);
  const inCurrentScope = useCallback((path: string): boolean => scopePaths === null || scopePaths.has(path) || localScopePaths.has(path), [localScopePaths, scopePaths]);
  const associatedSourceIds = useMemo(() => new Set((snapshot?.files ?? [])
    .filter((entry) => entry.kind === 'file' && entry.frontmatter?.noteType === 'item')
    .flatMap((entry) => frontmatterStrings(entry.frontmatter?.sourceIds))), [snapshot]);
  const duplicateSourcePaths = useMemo(() => new Set((snapshot?.files ?? [])
    .filter((entry) => entry.kind === 'file' && entry.frontmatter?.noteType === 'source'
      && frontmatterStrings(entry.frontmatter.sourceIds).some((id) => associatedSourceIds.has(id)))
    .map((entry) => entry.path)), [associatedSourceIds, snapshot]);
  const isCanonicalSemanticPath = (path: string): boolean => {
    if (semanticIdentityByPathRef.current.has(path)) return true;
    const frontmatter = snapshot?.files.find((entry) => entry.path === path)?.frontmatter
      ?? (noteRef.current?.path === path ? noteRef.current.metadata?.frontmatter : undefined);
    return frontmatter?.noteType === 'topic' || frontmatter?.noteType === 'chapter';
  };
  const linkTargets = useMemo(() => (snapshot?.files ?? [])
    .filter((entry) => entry.kind === 'file' && entry.extension?.toLocaleLowerCase() === 'md' && !duplicateSourcePaths.has(entry.path))
    .map((entry) => ({ path: entry.path, title: frontmatterTitle(entry.frontmatter, entry.path) }))
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.path.localeCompare(b.path)), [duplicateSourcePaths, snapshot]);
  const wikiCompletion = mode === 'read' ? null : incompleteWikiLinkAt(content, outlineCursor);
  const linkSuggestions = useMemo(() => {
    if (wikiCompletion === null) return [];
    const query = wikiCompletion.query.trim().toLocaleLowerCase();
    return linkTargets.filter((target) => target.path !== selectedPath
      && (query === '' || target.title.toLocaleLowerCase().includes(query) || target.path.toLocaleLowerCase().includes(query)
        || fuzzyMatchRanges(query, target.title).length > 0))
      .sort((a, b) => Number(!inCurrentScope(a.path)) - Number(!inCurrentScope(b.path))
        || a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.path.localeCompare(b.path))
      .slice(0, 8);
  }, [inCurrentScope, linkTargets, selectedPath, wikiCompletion]);

  const rememberDeletedPaths = useCallback((paths: readonly string[]): void => {
    const root = snapshot?.rootPath;
    if (root === undefined || paths.length === 0) return;
    setDeletedPaths((existing) => {
      const next = [...new Set([...paths, ...existing])].slice(0, 50);
      try { window.localStorage.setItem(`noltri:vault-deleted:${encodeURIComponent(root)}`, JSON.stringify(next)); } catch { /* Recovery history remains available for this session. */ }
      return next;
    });
  }, [snapshot?.rootPath]);

  const reloadSnapshot = useCallback(async (expectedContext?: VaultContextIdentity): Promise<boolean> => {
    const context = expectedContext ?? captureVaultContext();
    const unboundEpoch = vaultEpochRef.current;
    try {
      const next = await api.vaultSnapshot();
      if (context === null) {
        if (rootPathRef.current !== null || vaultEpochRef.current !== unboundEpoch) return false;
      } else if (!ownsVaultContext(context) || next.rootPath !== context.rootPath) return false;
      if (context === null) {
        rootPathRef.current = next.rootPath;
        vaultEpochRef.current += 1;
      }
      setSnapshot(next);
      revisionRef.current = next.revision;
      setError(null);
      const selected = contextPathRef.current;
      const frontmatter = selected === null
        ? null
        : noteRef.current?.path === selected
          ? noteRef.current.metadata?.frontmatter ?? null
          : next.files.find((entry) => entry.path === selected)?.frontmatter ?? null;
      publishContext(next, selected, frontmatter);
      return true;
    } catch (cause) {
      const stillCurrent = context === null
        ? rootPathRef.current === null && vaultEpochRef.current === unboundEpoch
        : ownsVaultContext(context);
      if (stillCurrent) setError(errorText(cause));
      return false;
    }
  }, [api, captureVaultContext, ownsVaultContext, publishContext]);

  useEffect(() => { if (active && snapshot === null) void reloadSnapshot(); }, [active, snapshot, reloadSnapshot]);

  useEffect(() => { setLocalScopePaths(new Set()); }, [scopePaths]);

  useEffect(() => {
    if (snapshot === null) { setDeletedPaths([]); return; }
    try {
      const raw = window.localStorage.getItem(`noltri:vault-deleted:${encodeURIComponent(snapshot.rootPath)}`);
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      setDeletedPaths(Array.isArray(parsed) ? parsed.filter((path): path is string => typeof path === 'string') : []);
    } catch { setDeletedPaths([]); }
  }, [snapshot?.rootPath]);

  useEffect(() => {
    if (assetRequest === null || snapshot === null) return;
    const context = captureVaultContext();
    if (context === null || context.rootPath !== snapshot.rootPath) return;
    let cancelled = false;
    void api.getVaultAsset(assetRequest.path).then((asset) => {
      if (!cancelled && ownsVaultContext(context)) setAssetPreview(asset);
    }).catch((cause) => {
      if (!cancelled && ownsVaultContext(context)) setError(errorText(cause));
    });
    return () => { cancelled = true; };
  }, [api, assetRequest?.id, captureVaultContext, ownsVaultContext, snapshot]);

  useEffect(() => {
    if (previewRequest === null) return;
    if (previewRequest.anchor === null) { schedulePreviewClose(); return; }
    if (previewTimer.current !== null) clearTimeout(previewTimer.current);
    if (previewOpenTimer.current !== null) clearTimeout(previewOpenTimer.current);
    let cancelled = false;
    void api.vaultFile(previewRequest.path).then((file) => {
      if (!cancelled) setPreviewTarget({ path: file.path, title: frontmatterTitle(snapshot?.files.find((entry) => entry.path === file.path)?.frontmatter, file.path), content: file.content, anchor: previewRequest.anchor! });
    }).catch(() => { if (!cancelled) setPreviewTarget(null); });
    return () => { cancelled = true; };
  }, [api, previewRequest?.id, snapshot]);

  useEffect(() => {
    if (snapshot === null) return;
    const key = `noltri:vault-trust:${encodeURIComponent(snapshot.rootPath)}`;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) {
        const saved = JSON.parse(raw) as Partial<TrustSettings>;
        setTrust({ html: saved.html === true, mermaid: saved.mermaid === true });
      } else setTrust({ html: false, mermaid: false });
    } catch { setTrust({ html: false, mermaid: false }); }
  }, [snapshot?.rootPath]);

  useEffect(() => {
    if (snapshot === null) return;
    const rootPath = snapshot.rootPath;
    const initial: VaultSettings = { newLinkFormat: 'shortest', propertyTypes: {} };
    settingsRootRef.current = rootPath;
    vaultSettingsRef.current = initial;
    setVaultSettings(initial);
    setSettingsReady(false);
    let cancelled = false;
    setSettingsBusy(true);
    setSettingsError(null);
    void (async () => {
      const value = normalizedVaultSettings(await api.vaultSettings(rootPath));
      let next = value;
      if (Object.keys(value.propertyTypes ?? {}).length === 0) {
        const legacyKey = `noltri:vault-property-types:${encodeURIComponent(rootPath)}`;
        const raw = window.localStorage.getItem(legacyKey);
        if (raw !== null) {
          const migrated = parseLegacyPropertyTypes(raw);
          if (Object.keys(migrated).length > 0) {
            next = normalizedVaultSettings(await api.updateVaultSettings({ newLinkFormat: value.newLinkFormat, propertyTypes: migrated }, rootPath));
          }
          window.localStorage.removeItem(legacyKey);
        }
      }
      if (!cancelled && settingsRootRef.current === rootPath) {
        vaultSettingsRef.current = next;
        setVaultSettings(next);
        setSettingsReady(true);
      }
    })().catch((cause: unknown) => {
      if (!cancelled) setSettingsError(errorText(cause));
    }).finally(() => {
      if (!cancelled) setSettingsBusy(false);
    });
    return () => { cancelled = true; if (settingsRootRef.current === rootPath) settingsRootRef.current = null; };
  }, [api, snapshot?.rootPath]);

  useEffect(() => {
    if (snapshot === null) { setRecentCommandIds([]); return; }
    try {
      const stored = window.localStorage.getItem(`noltri:vault-commands:${encodeURIComponent(snapshot.rootPath)}`);
      const parsed: unknown = stored === null ? [] : JSON.parse(stored);
      setRecentCommandIds(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
    } catch { setRecentCommandIds([]); }
  }, [snapshot?.rootPath]);

  const reconcileChangedPath = useCallback(async (path: string, context: VaultContextIdentity): Promise<void> => {
    const ownerId = noteOwnerRef.current?.id;
    if (ownerId === undefined || !ownsNoteContext(context, path, ownerId)) return;
    try {
      const fresh = await api.vaultFile(path);
      if (!ownsNoteContext(context, path, ownerId)) return;
      const changeKey = vaultChangeKey(context.rootPath, path);
      const current = noteRef.current;
      const action = classifyNoteChange(pendingWritesRef.current.get(changeKey) ?? 0, current, fresh, contentRef.current);
      if (action === 'defer') {
        deferredChangesRef.current.add(changeKey);
        return;
      }
      if (action === 'ignore') return;
      if (action === 'reload') {
        if (!updateLoadedNote(fresh, context, ownerId)) return;
        commitContent(fresh.content);
        setMetadata(fresh.metadata ?? null);
        setSaveState('saved');
        if (draftWritesRef.current?.clear(context.rootPath, path) === false) setError('磁盘版本已载入，但旧本机恢复草稿无法清除；请手动检查恢复入口。');
        else setError(null);
      } else {
        setSaveState('conflict');
        setError('文件在外部发生更改。请重新载入或复制草稿，当前内容不会覆盖外部版本。');
        draftWritesRef.current?.flush(context.rootPath, path, contentRef.current, { baseEtag: noteRef.current?.path === path ? noteRef.current.etag : null, conflict: true });
      }
    } catch { /* A deleted file stays open so the user can copy its draft. */ }
  }, [api, commitContent, ownsNoteContext, updateLoadedNote]);

  useEffect(() => {
    if (snapshot !== null) publishContext(snapshot, selectedPath, note?.metadata?.frontmatter ?? null);
    contextPathRef.current = selectedPath;
  }, [note?.metadata?.frontmatter, snapshot, selectedPath, publishContext]);

  const confirmLegacyDraftSaved = useCallback((path: string): void => {
    const pending = legacyDraftRef.current;
    if (pending?.path !== path) return;
    legacyDraftRef.current = null;
    onLegacyDraftSaved?.(pending.draft);
  }, [onLegacyDraftSaved]);

  const saveCurrent = useCallback(async (path = selectedPath): Promise<boolean> => {
    if (path === null) return true;
    const owner = noteOwnerRef.current;
    if (owner === null || owner.path !== path || !ownsNoteContext(owner, path, owner.id)) return false;
    const context: VaultContextIdentity = { rootPath: owner.rootPath, epoch: owner.epoch };
    const root = context.rootPath;
    const changeKey = vaultChangeKey(root, path);
    return drainNoteFlush(
      () => {
        const current = noteRef.current;
        return { valid: ownsNoteContext(context, path, owner.id) && current?.path === path, content: contentRef.current, saved: current?.content ?? '', pending: pendingWritesRef.current.get(changeKey) ?? 0 };
      },
      async () => { await saveChain.current.catch(() => undefined); },
      async () => {
        if (!ownsNoteContext(context, path, owner.id)) return false;
        const pending = pendingWritesRef.current.get(changeKey) ?? 0;
      setSaveState('saving');
      setError(null);
      let canContinue = true;
      pendingWritesRef.current.set(changeKey, pending + 1);
      const operation = saveChain.current.catch(() => undefined).then(async () => {
        const saveFile = async (input: { path: string; content: string; expectedEtag?: string }): Promise<NoteFile> => {
          const current = noteRef.current;
          let identity = semanticIdentityByPathRef.current.get(input.path);
          let canonical: Awaited<ReturnType<WorkbenchApi['legacyNotePath']>> | null = null;
          if (identity === undefined) {
            const frontmatter = current?.path === input.path ? current.metadata?.frontmatter : null;
            const noteType = frontmatter?.noteType;
            if (noteType !== 'topic' && noteType !== 'chapter') return api.saveVaultFile(input, root);
            const topicId = frontmatter?.topicId;
            const chapterId = noteType === 'chapter' ? frontmatter?.chapterId : null;
            if (typeof topicId !== 'string' || topicId.trim() === ''
              || noteType === 'chapter' && (typeof chapterId !== 'string' || chapterId.trim() === '')) {
              throw new Error('主题笔记身份信息不完整；为避免写入错误主题，正文未保存。');
            }
            identity = { topicId, chapterId: chapterId as string | null };
            canonical = await api.legacyNotePath(identity.topicId, identity.chapterId);
            if (!canonical.exists || canonical.path !== input.path) throw new Error('主题笔记路径与知识库映射不一致；正文未保存。');
            semanticIdentityByPathRef.current.set(input.path, identity);
          }
          if (canonical === null) canonical = await api.legacyNotePath(identity.topicId, identity.chapterId);
          if (!canonical.exists || canonical.path !== input.path) throw new Error('主题笔记路径与知识库映射不一致；正文未保存。');
          const properties = graphNoteProperties(input.content);
          const originalProperties = graphNoteProperties(current?.path === input.path ? current.content : '');
          await api.saveGraphNote(identity.topicId, {
            chapterId: identity.chapterId,
            content: noteBody(input.content),
            expectedEtag: input.expectedEtag,
            ...(!sameProperties(properties, originalProperties) ? { properties } : {}),
          }, root);
          const saved = await api.vaultFile(input.path);
          if (contentRef.current === input.content) commitContent(saved.content);
          return saved;
        };
        const outcome = await saveLatestNoteWithEtag(saveFile, path, () => {
          if (!ownsNoteContext(context, path, owner.id)) return null;
          const current = noteRef.current;
          return current?.path === path ? current : null;
        }, () => contentRef.current);
        const ownsCurrentContext = ownsNoteContext(context, path, owner.id);
        if (outcome.kind === 'missing') { canContinue = false; return; }
        if (outcome.kind === 'unchanged') {
          if (ownsCurrentContext) {
            setSaveState('saved');
            draftWritesRef.current?.clear(root, path);
            confirmLegacyDraftSaved(path);
          }
          return;
        }
        if (outcome.kind === 'conflict') {
          canContinue = false;
          if (ownsCurrentContext) {
            setSaveState('conflict');
            setError('文件在外部发生更改。请重新载入或复制草稿，当前内容不会覆盖外部版本。');
            draftWritesRef.current?.flush(root, path, contentRef.current, { baseEtag: noteRef.current?.etag ?? null, conflict: true });
          }
          return;
        }
        const result = outcome.file;
        if (ownsCurrentContext) {
          updateLoadedNote(result, context, owner.id);
          setMetadata(result.metadata ?? null);
          if (contentRef.current === result.content) {
            setSaveState('saved');
            draftWritesRef.current?.clear(root, path);
            confirmLegacyDraftSaved(path);
          } else setSaveState('dirty');
        } else canContinue = false;
      }).catch((cause) => {
        canContinue = false;
        if (ownsNoteContext(context, path, owner.id)) {
          setSaveState('error');
          setError(errorText(cause));
          draftWritesRef.current?.flush(root, path, contentRef.current, { baseEtag: noteRef.current?.etag ?? null, conflict: false });
        }
      });
      // Keep changes events deferred through every queued write, then reconcile against the final etag.
      const settled = operation.finally(() => {
        if (pendingWritesRef.current.has(changeKey)) {
          const remaining = (pendingWritesRef.current.get(changeKey) ?? 1) - 1;
          if (remaining <= 0) {
            pendingWritesRef.current.delete(changeKey);
            if (deferredChangesRef.current.delete(changeKey)) void reconcileChangedPath(path, context);
          } else pendingWritesRef.current.set(changeKey, remaining);
        }
      });
      saveChain.current = settled;
        await settled;
        return canContinue && ownsNoteContext(context, path, owner.id);
      },
    );
  }, [api, commitContent, confirmLegacyDraftSaved, ownsNoteContext, reconcileChangedPath, selectedPath, snapshot?.rootPath, updateLoadedNote]);

  const flushForNavigation = useCallback(async (): Promise<boolean> => {
    const path = contextPathRef.current;
    if (path === null) return noteRef.current === null && noteOwnerRef.current === null;
    return saveCurrent(path);
  }, [saveCurrent]);
  useEffect(() => onRegisterFlushHandler?.(flushForNavigation), [flushForNavigation, onRegisterFlushHandler]);
  useEffect(() => {
    if (snapshot !== null) onVaultEntriesChange?.(snapshot.files);
  }, [onVaultEntriesChange, snapshot]);

  useEffect(() => {
    const root = snapshot?.rootPath ?? null;
    if (semanticIdentityRootRef.current === root) return;
    semanticIdentityRootRef.current = root;
    semanticIdentityByPathRef.current.clear();
  }, [snapshot?.rootPath]);

  useEffect(() => {
    if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    if (note === null || !hasUnsavedContent(note.path)) return;
    const owner = noteOwnerRef.current;
    if (owner === null || owner.path !== note.path || owner.rootPath !== rootPathRef.current) return;
    draftWritesRef.current?.schedule(owner.rootPath, note.path, content, { baseEtag: note.etag, conflict: saveState === 'conflict' });
    if (saveState === 'conflict') return;
    setSaveState('dirty');
    saveTimer.current = window.setTimeout(() => { void saveCurrent(note.path); }, 650);
    return () => { if (saveTimer.current !== null) clearTimeout(saveTimer.current); };
  }, [content, hasUnsavedContent, note, saveState, saveCurrent]);

  useEffect(() => {
    if (note === null || snapshot === null) return undefined;
    const owner = noteOwnerRef.current;
    if (owner === null || owner.path !== note.path || owner.rootPath !== snapshot.rootPath) return undefined;
    const context: VaultContextIdentity = { rootPath: owner.rootPath, epoch: owner.epoch };
    const path = owner.path;
    const flushOnPageHide = (): void => {
      const current = noteRef.current;
      if (ownsNoteContext(context, path, owner.id) && current?.path === path && contentRef.current !== current.content) {
        draftWritesRef.current?.flush(context.rootPath, path, contentRef.current, { baseEtag: current.etag, conflict: saveState === 'conflict' });
      }
    };
    window.addEventListener('pagehide', flushOnPageHide);
    return () => window.removeEventListener('pagehide', flushOnPageHide);
  }, [note?.path, ownsNoteContext, saveState, snapshot?.rootPath]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; draftWritesRef.current?.flushPending(); };
  }, []);

  const openNote = useCallback(async (path: string, subpath?: string | null, intent: { newTab?: boolean; split?: boolean } = {}, forceReload = false): Promise<void> => {
    const requestContext = captureVaultContext();
    if (requestContext === null || snapshot?.rootPath !== requestContext.rootPath) return;
    if (intent.split) {
      const requestId = ++splitLoadRequestId.current;
      const current = noteRef.current;
      if (current !== null && hasUnsavedContent(current.path) && !(await saveCurrent(current.path))) return;
      if (!ownsVaultContext(requestContext)) return;
      try {
        const file = await api.vaultFile(path);
        if (requestId === splitLoadRequestId.current && ownsVaultContext(requestContext)) setSplitNote(file);
      } catch (cause) { if (ownsVaultContext(requestContext)) setError(errorText(cause)); }
      return;
    }
    if (path === selectedPath && !forceReload && ownsNoteContext(requestContext, path)) { if (subpath) setJumpTo(subpath); return; }
    const releaseTransition = beginTransition();
    try {
      const requestId = ++noteLoadRequestId.current;
      const current = noteRef.current;
      if (!forceReload && current !== null && hasUnsavedContent(current.path) && !(await saveCurrent(current.path))) return;
      if (!ownsVaultContext(requestContext)) return;
      const file = await api.vaultFile(path);
      if (requestId !== noteLoadRequestId.current || !ownsVaultContext(requestContext)) return;
      setTabs((current) => {
        if (current.includes(path)) return current;
        if (intent.newTab || current.length === 0 || selectedPath === null) return [...current, path];
        return current.map((tab) => tab === selectedPath ? path : tab);
      });
      setSelectedPath(path);
      const ownerId = bindLoadedNote(file, requestContext);
      contextPathRef.current = path;
      mentionsPathRef.current = null;
      commitContent(file.content);
      setSaveState('saved');
      setError(null);
      metadataRevisionRef.current = -1;
      backlinksRevisionRef.current = -1;
      mentionsRevisionRef.current = -1;
      setMetadata(null); setBacklinks([]); setMentions([]); setHistory([]);
      setDraftAvailable(getDraft(requestContext.rootPath, path) !== null);
      setJumpTo(subpath ?? null);
      publishContext(snapshot, path, file.metadata?.frontmatter ?? null);
      const relatedRequestRevision = revisionRef.current;
      const [meta, back, mention, versions] = await Promise.allSettled([
        api.vaultMetadata(path), api.vaultBacklinks(path), api.vaultMentions(path), api.vaultHistory(path),
      ]);
      if (requestId !== noteLoadRequestId.current || !ownsNoteContext(requestContext, path, ownerId)
        || contextPathRef.current !== path) return;
      if (meta.status === 'fulfilled' && relatedRequestRevision >= metadataRevisionRef.current) {
        metadataRevisionRef.current = relatedRequestRevision;
        setMetadata(meta.value.metadata);
      }
      if (back.status === 'fulfilled' && back.value.revision >= backlinksRevisionRef.current) {
        backlinksRevisionRef.current = back.value.revision;
        setBacklinks(back.value.backlinks);
      }
      if (mention.status === 'fulfilled' && relatedRequestRevision >= mentionsRevisionRef.current) {
        mentionsRevisionRef.current = relatedRequestRevision;
        setMentions(mention.value.mentions);
      }
      setHistory(versions.status === 'fulfilled' ? versions.value.versions : []);
      publishContext(snapshot, path, file.metadata?.frontmatter ?? null);
      mentionsPathRef.current = path;
    } catch (cause) { if (ownsVaultContext(requestContext)) setError(errorText(cause)); }
    finally { releaseTransition(); }
  }, [api, beginTransition, bindLoadedNote, captureVaultContext, commitContent, hasUnsavedContent, ownsNoteContext, ownsVaultContext, publishContext, saveCurrent, selectedPath, snapshot]);

  useEffect(() => {
    if (active && snapshot !== null && requestedOpen !== null && requestedOpen.id !== lastOpenRequestId.current) {
      lastOpenRequestId.current = requestedOpen.id;
      if (requestedOpen.semanticIdentity !== undefined) semanticIdentityByPathRef.current.set(requestedOpen.path, requestedOpen.semanticIdentity);
      void openNote(requestedOpen.path, requestedOpen.subpath, requestedOpen.intent).then(() => {
        if (requestedOpen.draftContent === undefined || requestedOpen.intent.split || noteRef.current?.path !== requestedOpen.path) return;
        commitContent(requestedOpen.draftContent);
        setSaveState('dirty');
        setDraftAvailable(true);
        if (requestedOpen.legacyDraft !== undefined) legacyDraftRef.current = { path: requestedOpen.path, draft: requestedOpen.legacyDraft };
      });
    }
  }, [active, commitContent, openNote, requestedOpen, snapshot]);

  useEffect(() => {
    if (!active || scopePaths === null || selectedPath === null || inCurrentScope(selectedPath)
      || requestedOpen?.path === selectedPath) return;
    const path = selectedPath;
    void (async () => {
      if (hasUnsavedContent(path) && !(await saveCurrent(path))) {
        setError('当前笔记尚未保存，仍保留在编辑区；请重试保存后再切换范围。');
        return;
      }
      if (selectedPath !== path) return;
      setSelectedPath(null);
      clearLoadedNote();
      commitContent('');
      metadataRevisionRef.current = -1;
      backlinksRevisionRef.current = -1;
      mentionsRevisionRef.current = -1;
      setMetadata(null);
      setBacklinks([]);
      setMentions([]);
      setHistory([]);
      publishContext(snapshot, null);
    })();
  }, [active, clearLoadedNote, commitContent, hasUnsavedContent, inCurrentScope, publishContext, requestedOpen?.path, saveCurrent, scopePaths, selectedPath, snapshot]);

  useEffect(() => {
    if (tagQuery !== null && active) onSearchRequest?.(tagQuery);
  }, [active, onSearchRequest, tagQuery]);

  useEffect(() => {
    if (!active || commandRequestId === 0 || commandRequestId === lastCommandRequestId.current) return;
    lastCommandRequestId.current = commandRequestId;
    setCommandOpen(true);
    setSwitcherQuery('');
  }, [active, commandRequestId]);

  useEffect(() => {
    setSearchQuery(workspaceSearchQuery);
  }, [workspaceSearchQuery]);

  useEffect(() => {
    const snapshotRootPath = snapshot?.rootPath;
    if (!active || snapshotRootPath === undefined) return undefined;
    const context: VaultContextIdentity = { rootPath: snapshotRootPath, epoch: vaultEpochRef.current };
    let cancelled = false;
    const refreshRelatedView = (path: string, owner: LoadedNoteOwner, requestRevision: number): void => {
      if (!ownsNoteContext(context, path, owner.id)) return;
      const stillOwnsRelatedView = (): boolean => mountedRef.current && ownsNoteContext(context, path, owner.id);
      void api.vaultMetadata(path).then((result) => {
        if (stillOwnsRelatedView() && requestRevision >= metadataRevisionRef.current) {
          metadataRevisionRef.current = requestRevision;
          setMetadata(result.metadata);
        }
      }).catch(() => undefined);
      void api.vaultBacklinks(path).then((result) => {
        if (stillOwnsRelatedView() && result.revision >= backlinksRevisionRef.current) {
          backlinksRevisionRef.current = result.revision;
          setBacklinks(result.backlinks);
        }
      }).catch(() => undefined);
      void api.vaultMentions(path).then((result) => {
        if (stillOwnsRelatedView() && requestRevision >= mentionsRevisionRef.current) {
          mentionsRevisionRef.current = requestRevision;
          setMentions(result.mentions);
        }
      }).catch(() => undefined);
    };
    const checkChanges = async (): Promise<void> => {
      if (document.visibilityState !== 'visible') return;
      if (changesPollInFlightRef.current) return;
      changesPollInFlightRef.current = true;
      try {
        const changes = await api.vaultChanges(revisionRef.current);
        if (cancelled || !ownsVaultContext(context)) return;
        revisionRef.current = Math.max(revisionRef.current, changes.revision);
        if (changes.reset) {
          metadataRevisionRef.current = -1;
          backlinksRevisionRef.current = -1;
          mentionsRevisionRef.current = -1;
          const reloaded = await reloadSnapshot(context);
          if (reloaded && ownsVaultContext(context)) {
            const owner = noteOwnerRef.current;
            if (owner !== null) refreshRelatedView(owner.path, owner, revisionRef.current);
            onVaultDocumentsChanged?.([]);
          }
          return;
        }
        if (changes.events.length === 0) return;
        const currentChanged = changes.events.some((event) => event.path === selectedPath);
        if (selectedPath !== null && currentChanged) {
          const changeKey = vaultChangeKey(context.rootPath, selectedPath);
          if (pendingWritesRef.current.has(changeKey)) deferredChangesRef.current.add(changeKey);
          else await reconcileChangedPath(selectedPath, context);
        }
        const refreshRevision = changes.revision;
        const snapshotRefresh = reloadSnapshot(context);
        const owner = noteOwnerRef.current;
        const relatedPath = owner?.path;
        if (relatedPath !== undefined && owner !== null) refreshRelatedView(relatedPath, owner, refreshRevision);
        const snapshotReloaded = await snapshotRefresh;
        const changedMarkdownPaths = changes.events
          .map((event) => event.path)
          .filter((path): path is string => typeof path === 'string' && path.toLocaleLowerCase().endsWith('.md'));
        if (snapshotReloaded && changedMarkdownPaths.length > 0 && ownsVaultContext(context)) onVaultDocumentsChanged?.(changedMarkdownPaths);
      } catch { /* Polling is best-effort; the next tick can recover. */ }
      finally { changesPollInFlightRef.current = false; }
    };
    const onVisibilityChange = (): void => { if (document.visibilityState === 'visible') void checkChanges(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    const timer = window.setInterval(() => { void checkChanges(); }, 50);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [active, api, onVaultDocumentsChanged, ownsNoteContext, ownsVaultContext, reconcileChangedPath, reloadSnapshot, selectedPath, snapshot?.rootPath]);

  const displayTitlesByPath = useMemo(() => {
    const titles = (snapshot?.files ?? []).filter((entry) => entry.kind === 'file').map((entry) => ({
      path: entry.path,
      title: frontmatterTitle(entry.frontmatter, entry.path),
    }));
    const counts = new Map<string, number>();
    for (const { title } of titles) counts.set(title.toLocaleLowerCase(), (counts.get(title.toLocaleLowerCase()) ?? 0) + 1);
    return new Map(titles.map(({ path, title }) => [path, (counts.get(title.toLocaleLowerCase()) ?? 0) > 1
      ? `${title} · ${path.split('/').slice(0, -1).join('/') || '根目录'}` : title]));
  }, [snapshot]);
  const titleForPath = (path: string, frontmatter?: Record<string, unknown>): string =>
    frontmatterTitle(frontmatter ?? snapshot?.files.find((entry) => entry.path === path)?.frontmatter, path);
  const headings = metadata?.headings ?? [...content.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((match) => ({ heading: match[2] ?? '', level: match[1]?.length ?? 1, position: { start: { line: 0, col: 0, offset: match.index ?? 0 }, end: { line: 0, col: 0, offset: (match.index ?? 0) + match[0].length } } }));
  const tagValues = [...new Set(metadata?.tags?.map((tag) => tag.tag.replace(/^#/, '')) ?? (content.match(/#[\p{L}\p{N}_/-]+/gu) ?? []).map((tag) => tag.slice(1)))];
  const tagCounts = new Map<string, number>();
  for (const tag of tagValues) {
    const parts = tag.split('/').filter(Boolean);
    const ancestors = new Set(parts.map((_, index) => parts.slice(0, index + 1).join('/')));
    for (const parentTag of ancestors) tagCounts.set(parentTag, (tagCounts.get(parentTag) ?? 0) + 1);
  }
  const tags = (vaultTagCounts.size > 0 ? [...vaultTagCounts.keys()] : [...tagCounts.keys()]).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const searchRanges = useMemo(() => search?.results.find((result) => result.path === selectedPath)?.matches
    .filter((range) => range.field === 'content')
    .map(({ start, end }) => ({ start, end })) ?? [], [search, selectedPath]);
  const visibleSwitcherResults = useMemo(() => switcherResults.filter((result) => !duplicateSourcePaths.has(result.path)), [duplicateSourcePaths, switcherResults]);

  useEffect(() => {
    if (searchQuery.trim() === '') { setSearch(null); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api.searchVault(searchQuery.trim(), 80).then((result) => { if (!cancelled) setSearch(result); }).catch((cause) => { if (!cancelled) setError(errorText(cause)); });
    }, 160);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [api, searchQuery]);

  useEffect(() => {
    if (!commandOpen || switcherQuery.trim() === '' || switcherQuery.trim().startsWith('>')) { setSwitcherResults([]); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api.switcherVault(switcherQuery.trim(), 30).then((result) => { if (!cancelled) setSwitcherResults(result.results); }).catch(() => undefined);
    }, 90);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [api, commandOpen, switcherQuery]);

  useEffect(() => {
    const activeHeading = document.querySelector<HTMLElement>('.knowledge-right-tool-panel .vault-outline-list button.is-active');
    activeHeading?.scrollIntoView({ block: 'nearest' });
  }, [outlineCursor, selectedPath]);

  async function createNote(): Promise<void> {
    const context = captureVaultContext();
    if (snapshot === null || context === null || snapshot.rootPath !== context.rootPath) return;
    const path = newNotePath.trim().replace(/^\/+/, '').replace(/\/+/g, '/');
    if (path === '' || path.includes('..') || path.startsWith('.')) { setError('请输入笔记库内的相对路径，例如 Inbox/新笔记.md。'); return; }
    const finalPath = /\.md$/i.test(path) ? path : `${path}.md`;
    try {
      const created = await api.saveVaultFile({ path: finalPath, content: `# ${basename(finalPath)}\n\n` }, context.rootPath);
      if (!ownsVaultContext(context)) return;
      if (scopePaths !== null) setLocalScopePaths((current) => new Set(current).add(created.path));
      if (!await reloadSnapshot(context) || !ownsVaultContext(context)) return;
      setNewNoteOpen(false); setNewNotePath('');
      if (onNavigateRequest !== undefined) onNavigateRequest(created.path); else await openNote(created.path);
    } catch (cause) { if (ownsVaultContext(context)) setError(errorText(cause)); }
  }

  async function deleteTreeEntry(entry: VaultEntry): Promise<void> {
    if (isCanonicalSemanticPath(entry.path)) { setError('主题笔记路径由知识内容维护，不能通过文件删除。'); return; }
    const context = captureVaultContext();
    const sourceSnapshot = snapshot;
    if (sourceSnapshot === null || context === null || sourceSnapshot.rootPath !== context.rootPath) return;
    const releaseTransition = beginTransition();
    try {
      const currentBeforeSave = noteRef.current;
      const ownerBeforeSave = noteOwnerRef.current;
      if (currentBeforeSave !== null && !(await saveCurrent(currentBeforeSave.path))) return;
      if (!ownsVaultContext(context)) return;
      let currentAfterSave: NoteFile | null = null;
      if (currentBeforeSave !== null) {
        if (ownerBeforeSave === null || !ownsNoteContext(ownerBeforeSave, currentBeforeSave.path, ownerBeforeSave.id)) return;
        currentAfterSave = noteRef.current;
        if (currentAfterSave?.path !== currentBeforeSave.path) return;
      }
      const preview = await api.deletePreview(entry.path);
      if (!ownsVaultContext(context)) return;
      if (currentAfterSave !== null
        && (ownerBeforeSave === null || !ownsNoteContext(ownerBeforeSave, currentAfterSave.path, ownerBeforeSave.id))) return;
      if (preview.kind !== entry.kind) {
        setError('Core 没有返回匹配路径的安全删除预览，已取消删除。请更新 Core 后重试。');
        return;
      }
      const previewKind = preview.kind;
      const latestCurrent = currentAfterSave === null ? null : noteRef.current;
      if (currentAfterSave !== null && latestCurrent?.path !== currentAfterSave.path) return;
      if (previewKind === 'file' && latestCurrent?.path === entry.path && preview.etag !== latestCurrent.etag) {
        setSaveState('conflict');
        setError('文件在外部发生更改，已取消删除；请重新载入后再试。');
        return;
      }
      const descendants = preview.descendantCount;
      const orphanSummary = preview.orphanAttachments.map((item) => `• ${item.path}`).join('\n');
      const prompt = [
        `删除 ${entry.path}？`,
        previewKind === 'folder' ? `将递归删除 ${descendants} 个文件及其子文件夹。` : '',
        preview.backlinkCount > 0 ? `仍有 ${preview.backlinkCount} 个反向链接。` : '',
        preview.orphanAttachments.length > 0 ? `检测到 ${preview.orphanAttachments.length} 个孤儿附件：\n${orphanSummary}` : '',
        '删除前会保存可恢复快照。',
      ].filter(Boolean).join('\n');
      if (!window.confirm(prompt)) return;
      const orphanPolicy = preview.orphanAttachments.length > 0 && window.confirm('同时删除这些孤儿附件？取消会保留附件。') ? 'always' : 'never';
      if (!ownsVaultContext(context)) return;
      const deletedEntryPaths = sourceSnapshot.files
        .filter((file) => file.kind === 'file' && vaultPathContains(file.path, entry.path))
        .map((file) => file.path);
      if (entry.kind === 'file' && !deletedEntryPaths.includes(entry.path)) deletedEntryPaths.push(entry.path);
      await api.deleteVaultFile(entry.path, preview.etag, orphanPolicy, context.rootPath);
      if (!ownsVaultContext(context)) return;
      if (orphanPolicy === 'always') {
        deletedEntryPaths.push(...preview.orphanAttachments.map((item) => item.path));
      }
      setDeletedPaths((paths) => {
        const next = [...new Set([...deletedEntryPaths, ...paths])].slice(0, 50);
        try { window.localStorage.setItem(`noltri:vault-deleted:${encodeURIComponent(context.rootPath)}`, JSON.stringify(next)); } catch { /* Recovery history remains available for this session. */ }
        return next;
      });
      const remaining = tabs.filter((path) => !vaultPathContains(path, entry.path));
      setTabs(remaining);
      setSplitNote((currentSplit) => currentSplit !== null && vaultPathContains(currentSplit.path, entry.path) ? null : currentSplit);
      setAssetPreview((asset) => asset !== null && vaultPathContains(asset.path, entry.path) ? null : asset);
      if (!await reloadSnapshot(context) || !ownsVaultContext(context)) return;
      if (selectedPath !== null && vaultPathContains(selectedPath, entry.path)) {
        noteLoadRequestId.current += 1;
        if (remaining.length > 0) {
          const nextPath = remaining.at(-1)!;
          if (onNavigateRequest !== undefined) onNavigateRequest(nextPath); else await openNote(nextPath, null, {}, true);
        }
        else {
          setSelectedPath(null); clearLoadedNote(); commitContent(''); setMetadata(null); setSaveState('saved');
          contextPathRef.current = null; mentionsPathRef.current = null;
          metadataRevisionRef.current = -1; backlinksRevisionRef.current = -1; mentionsRevisionRef.current = -1;
          setBacklinks([]); setMentions([]); setHistory([]);
          publishContext(sourceSnapshot, null);
          onNavigateRequest?.(null);
        }
      }
    } catch (cause) { if (ownsVaultContext(context)) setError(errorText(cause)); }
    finally { releaseTransition(); }
  }

  async function restoreDeletedPath(path: string, versionId: string): Promise<void> {
    if (!window.confirm(`恢复 ${path} 到此历史版本？`)) return;
    const context = captureVaultContext();
    if (context === null || snapshot?.rootPath !== context.rootPath) return;
    const releaseTransition = beginTransition();
    try {
      const current = noteRef.current;
      if (current !== null && !(await saveCurrent(current.path))) return;
      if (!ownsVaultContext(context)) return;
      try {
        await api.vaultFile(path);
        if (!ownsVaultContext(context)) return;
        setError('该路径已存在，已取消恢复以避免覆盖当前文件。');
        return;
      } catch (cause) {
        if (!ownsVaultContext(context)) return;
        if ((cause as { status?: number })?.status !== 404) throw cause;
      }
      await api.restoreVaultHistory({ path, versionId }, context.rootPath);
      if (!ownsVaultContext(context)) return;
      setDeletedPaths((paths) => {
        const next = paths.filter((item) => item !== path);
        try { window.localStorage.setItem(`noltri:vault-deleted:${encodeURIComponent(context.rootPath)}`, JSON.stringify(next)); } catch { /* This session can still finish the restore. */ }
        return next;
      });
      setRestorePath(null);
      if (!await reloadSnapshot(context) || !ownsVaultContext(context)) return;
      if (/\.md$/i.test(path)) { if (onNavigateRequest !== undefined) onNavigateRequest(path); else await openNote(path, null, {}, true); }
    } catch (cause) { if (ownsVaultContext(context)) setError(errorText(cause)); }
    finally { releaseTransition(); }
  }

  async function renameCurrent(): Promise<void> {
    if (note !== null && isCanonicalSemanticPath(note.path)) { setError('主题笔记路径由知识内容维护，不能通过文件改名更改身份。'); return; }
    const owner = noteOwnerRef.current;
    if (note === null || noteRef.current !== note || owner === null || owner.path !== note.path || !ownsNoteContext(owner, note.path, owner.id) || renamePath.trim() === '') return;
    const context: VaultContextIdentity = { rootPath: owner.rootPath, epoch: owner.epoch };
    const path = owner.path;
    const nextPath = renamePath.trim();
    const releaseTransition = beginTransition();
    try {
      if (hasUnsavedContent(path) && !(await saveCurrent(path))) return;
      if (!ownsNoteContext(context, path, owner.id)) return;
      const current = noteRef.current;
      if (current === null) return;
      const next = await api.renameVaultFile({ path, newPath: nextPath, expectedEtag: current.etag }, context.rootPath);
      if (!ownsNoteContext(context, path, owner.id)) return;
      if (scopePaths !== null && inCurrentScope(path)) setLocalScopePaths((paths) => new Set(paths).add(next.path));
      rememberDeletedPaths([path]);
      setRenamePath(''); setTabs((currentTabs) => currentTabs.map((tab) => tab === path ? next.path : tab));
      if (!await reloadSnapshot(context) || !ownsVaultContext(context)) return;
      if (onNavigateRequest !== undefined) onNavigateRequest(next.path); else await openNote(next.path);
    } catch (cause) { if (ownsNoteContext(context, path, owner.id)) setError(errorText(cause)); }
    finally { releaseTransition(); }
  }

  async function deleteCurrent(): Promise<void> {
    if (note !== null && isCanonicalSemanticPath(note.path)) { setError('主题笔记路径由知识内容维护，不能通过文件删除。'); return; }
    if (note === null || noteRef.current !== note || noteOwnerRef.current?.rootPath !== snapshot?.rootPath) return;
    const entry = snapshot?.files.find((file) => file.path === note.path) ?? { path: note.path, name: basename(note.path), kind: 'file' as const, extension: 'md' };
    await deleteTreeEntry(entry);
  }

  async function openLink(target: string, sourcePath?: string, kind: VaultLinkKind = 'wikilink'): Promise<void> {
    const context = captureVaultContext();
    if (context === null || snapshot?.rootPath !== context.rootPath) return;
    if (target.startsWith('#') && note !== null && (sourcePath === undefined || sourcePath === note.path)) { setJumpTo(target.slice(1)); setMode('read'); return; }
    if (/^https?:\/\//i.test(target)) {
      if (window.confirm(`即将打开外部链接：\n${target}\n\n是否继续？`)) window.open(target, '_blank', 'noopener,noreferrer');
      return;
    }
    if (/^mailto:/i.test(target)) {
      if (window.confirm(`即将打开邮件链接：\n${target}\n\n是否继续？`)) window.location.href = target;
      return;
    }
    if (/^\s*(?:javascript|data):/i.test(target)) { setError('此链接协议不安全，已阻止打开。'); return; }
    const separator = target.indexOf('#');
    const linkpath = separator < 0 ? target : target.slice(0, separator);
    const subpath = separator < 0 ? '' : target.slice(separator + 1);
    try {
      const resolved = await api.resolveVaultLink(linkpath, sourcePath ?? selectedPath ?? '', kind);
      if (!ownsVaultContext(context)) return;
      if (resolved.path === null) { setError(`找不到链接目标：${linkpath}`); return; }
      if (onNavigateRequest !== undefined) { onNavigateRequest(resolved.path, subpath || null); return; }
      await openNote(resolved.path, subpath || null);
    } catch (cause) { if (ownsVaultContext(context)) setError(errorText(cause)); }
  }

  async function restoreVersion(versionId: string): Promise<void> {
    const owner = noteOwnerRef.current;
    if (note === null || noteRef.current !== note || owner === null || owner.path !== note.path || !ownsNoteContext(owner, note.path, owner.id)
      || !window.confirm('恢复到此版本？当前正文会先保存在历史中。')) return;
    const context: VaultContextIdentity = { rootPath: owner.rootPath, epoch: owner.epoch };
    const path = owner.path;
    const releaseTransition = beginTransition();
    try {
      if (hasUnsavedContent(path) && !(await saveCurrent(path))) return;
      if (!ownsNoteContext(context, path, owner.id)) return;
      const current = noteRef.current;
      if (current === null) return;
      const restored = await api.restoreVaultHistory({ path, versionId, expectedEtag: current.etag }, context.rootPath);
      if (!ownsNoteContext(context, path, owner.id)) return;
      if (!updateLoadedNote(restored, context, owner.id)) return;
      commitContent(restored.content); setSaveState('saved');
      setMetadata(restored.metadata ?? null);
      const versions = await api.vaultHistory(path);
      if (ownsNoteContext(context, path, owner.id)) setHistory(versions.versions);
    } catch (cause) { if (ownsNoteContext(context, path, owner.id)) setError(errorText(cause)); }
    finally { releaseTransition(); }
  }

  async function convertMention(sourcePath: string, position: { start: { offset: number }; end: { offset: number } }): Promise<void> {
    if (transitionCountRef.current > 0) return;
    const targetPath = selectedPath;
    const owner = noteOwnerRef.current;
    if (snapshot === null || owner === null || snapshot.rootPath !== owner.rootPath) return;
    const context: VaultContextIdentity | null = owner === null ? null : { rootPath: owner.rootPath, epoch: owner.epoch };
    const ownerId = owner?.id;
    const targetRoot = context?.rootPath ?? null;
    const isCurrentTarget = (): boolean => context !== null && ownerId !== undefined
      && ownsNoteContext(context, targetPath ?? '', ownerId)
      && vaultPathContextMatches(targetRoot, rootPathRef.current, targetPath, contextPathRef.current, mentionsPathRef.current);
    if (!isCurrentTarget()) return;
    const task = (async (): Promise<void> => {
      try {
        const fresh = await api.vaultFile(sourcePath);
        if (!isCurrentTarget()) return;
        const paths = vaultLinkPathCandidates(targetPath!, sourcePath);
        let linkTarget = paths.absolute;
        if (vaultSettings.newLinkFormat === 'relative') linkTarget = paths.relative;
        else if (vaultSettings.newLinkFormat === 'shortest') {
          for (const candidate of paths.shortest) {
            try {
              const resolved = await api.resolveVaultLink(candidate, sourcePath);
              if (!isCurrentTarget()) return;
              if (resolved.path === targetPath) { linkTarget = candidate; break; }
            } catch {
              if (!isCurrentTarget()) return;
            }
          }
        }
        const nextContent = replaceMentionAt(fresh.content, position.start.offset, position.end.offset, basename(targetPath!), linkTarget, titleForPath(targetPath!));
        if (nextContent === null) throw new Error('提及位置已变化，请刷新后重试。');
        if (!isCurrentTarget()) return;
        const saved = await api.saveVaultFile({ path: sourcePath, content: nextContent, expectedEtag: fresh.etag }, targetRoot!);
        if (!isCurrentTarget()) return;
        if (sourcePath === targetPath) { if (!updateLoadedNote(saved, context!, ownerId)) return; commitContent(saved.content); setMetadata(saved.metadata ?? null); setSaveState('saved'); }
        const result = await api.vaultMentions(targetPath!);
        if (isCurrentTarget()) { setMentions(result.mentions); mentionsPathRef.current = targetPath; }
      } catch (cause) { if (isCurrentTarget()) setError(errorText(cause)); }
    })();
    mentionWritesRef.current.add(task);
    try { await task; } finally { mentionWritesRef.current.delete(task); }
  }

  async function updateProperty(key: string, value: unknown): Promise<void> {
    if (isCanonicalSemanticPath(noteRef.current?.path ?? '') && graphNoteSystemProperties.has(key)) {
      setError('主题笔记身份属性由知识库维护，不能手动编辑。');
      return;
    }
    try { commitContent(setFrontmatterProperty(contentRef.current, key, value)); }
    catch (cause) { setError(errorText(cause)); }
  }

  async function saveVaultSettings(update: (current: VaultSettings) => Pick<VaultSettings, 'newLinkFormat' | 'propertyTypes'>): Promise<boolean> {
    const rootPath = snapshot?.rootPath;
    if (rootPath === undefined || settingsRootRef.current !== rootPath || !settingsReady) return false;
    const pending = (settingsWritesByRootRef.current.get(rootPath) ?? 0) + 1;
    settingsWritesByRootRef.current.set(rootPath, pending);
    setSettingsBusy(true);
    setSettingsError(null);
    const operation = settingsWriteChainRef.current.catch(() => undefined).then(async () => {
      if (settingsRootRef.current !== rootPath) return false;
      const saved = normalizedVaultSettings(await api.updateVaultSettings(update(vaultSettingsRef.current), rootPath));
      if (settingsRootRef.current !== rootPath) return false;
      vaultSettingsRef.current = saved;
      setVaultSettings(saved);
      return true;
    });
    settingsWriteChainRef.current = operation.then(() => undefined, () => undefined);
    try {
      return await operation;
    } catch (cause) {
      if (settingsRootRef.current === rootPath) setSettingsError(errorText(cause));
      return false;
    } finally {
      const remaining = Math.max(0, (settingsWritesByRootRef.current.get(rootPath) ?? 1) - 1);
      if (remaining === 0) settingsWritesByRootRef.current.delete(rootPath);
      else settingsWritesByRootRef.current.set(rootPath, remaining);
      if (settingsRootRef.current === rootPath) setSettingsBusy(remaining > 0);
    }
  }

  async function updatePropertyType(key: string, type: PropertyType, current: unknown): Promise<void> {
    const saved = await saveVaultSettings((settings) => ({
      newLinkFormat: settings.newLinkFormat,
      propertyTypes: { ...settings.propertyTypes, [key]: type },
    }));
    if (!saved) return;
    if (type === 'text') await updateProperty(key, String(current ?? ''));
    else if (type === 'number') await updateProperty(key, Number.isFinite(Number(current)) ? Number(current) : 0);
    else if (type === 'boolean') await updateProperty(key, Boolean(current));
    else if (type === 'list') await updateProperty(key, Array.isArray(current) ? current : String(current ?? '').split(',').map((part) => part.trim()).filter(Boolean));
    else await updateProperty(key, current ?? {});
  }

  async function renameBlock(oldId: string): Promise<void> {
    const owner = noteOwnerRef.current;
    if (note === null || noteRef.current !== note || owner === null || owner.path !== note.path || !ownsNoteContext(owner, note.path, owner.id)) return;
    const context: VaultContextIdentity = { rootPath: owner.rootPath, epoch: owner.epoch };
    const path = owner.path;
    const newId = window.prompt(`将块 ID “${oldId}” 重命名为：`, oldId)?.trim();
    if (!newId || newId === oldId) return;
    if (!/^[\p{L}\p{N}_-]+$/u.test(newId)) { setError('块 ID 只能包含字母、数字、下划线和连字符。'); return; }
    const releaseTransition = beginTransition();
    try {
      if (hasUnsavedContent(path) && !(await saveCurrent(path))) return;
      if (!ownsNoteContext(context, path, owner.id)) return;
      const current = noteRef.current;
      if (current === null) return;
      const result = await api.renameVaultBlock({ path, oldId, newId, expectedEtag: current.etag }, context.rootPath);
      if (!ownsNoteContext(context, path, owner.id) || !updateLoadedNote(result.file, context, owner.id)) return;
      commitContent(result.file.content); setMetadata(result.file.metadata ?? null); setSaveState('saved');
      setSnapshot((state) => state === null || state.rootPath !== context.rootPath ? state : { ...state, revision: result.revision });
      await reloadSnapshot(context);
    } catch (cause) { if (ownsNoteContext(context, path, owner.id)) setError(errorText(cause)); }
    finally { releaseTransition(); }
  }

  function setTrustValue(next: TrustSettings): void {
    if (snapshot === null || snapshot.rootPath !== rootPathRef.current) return;
    setTrust(next);
    try { window.localStorage.setItem(`noltri:vault-trust:${encodeURIComponent(snapshot.rootPath)}`, JSON.stringify(next)); }
    catch { setError('无法保存当前笔记库的信任设置。'); }
  }

  async function updateLinkFormat(newLinkFormat: VaultSettings['newLinkFormat']): Promise<void> {
    await saveVaultSettings((settings) => ({ newLinkFormat, propertyTypes: settings.propertyTypes }));
  }

  function openPreview(target: string, anchor: DOMRect, sourcePath = selectedPath ?? '', kind: VaultLinkKind = 'wikilink'): void {
    const context = captureVaultContext();
    if (context === null || snapshot?.rootPath !== context.rootPath) return;
    if (previewTimer.current !== null) clearTimeout(previewTimer.current);
    if (previewOpenTimer.current !== null) clearTimeout(previewOpenTimer.current);
    const separator = target.indexOf('#');
    const linkpath = separator < 0 ? target : target.slice(0, separator);
    previewOpenTimer.current = window.setTimeout(() => {
      void api.resolveVaultLink(linkpath, sourcePath, kind).then(async (resolved) => {
        if (!ownsVaultContext(context)) return;
        if (resolved.path === null) return;
        const file = await api.vaultFile(resolved.path);
        if (!ownsVaultContext(context)) return;
        if (previewTimer.current !== null) clearTimeout(previewTimer.current);
        setPreviewTarget({ path: resolved.path, title: frontmatterTitle(snapshot?.files.find((entry) => entry.path === resolved.path)?.frontmatter, resolved.path), content: file.content, anchor });
      }).catch(() => undefined);
    }, modifierHeld.current ? 0 : 220);
  }

  function schedulePreviewClose(): void {
    if (previewOpenTimer.current !== null) clearTimeout(previewOpenTimer.current);
    if (previewTimer.current !== null) clearTimeout(previewTimer.current);
    previewTimer.current = window.setTimeout(() => setPreviewTarget(null), 2000);
  }

  const setModeValue = (next: EditorMode): void => { setMode(next); if (next === 'read') setJumpTo(null); };
  const trustedLink = useCallback((target: string, sourcePath?: string, kind: VaultLinkKind = 'wikilink') => { void openLink(target, sourcePath, kind); }, [selectedPath, note, content, saveCurrent]);

  async function closeTab(path: string): Promise<void> {
    const context = captureVaultContext();
    if (snapshot !== null && (context === null || context.rootPath !== snapshot.rootPath)) return;
    const selectedOwnerId = noteOwnerRef.current?.id;
    const releaseTransition = selectedPath === path ? beginTransition() : () => undefined;
    try {
      if (note?.path === path && hasUnsavedContent(path) && !(await saveCurrent(path))) return;
      if (selectedPath === path && context !== null && !ownsVaultContext(context)) return;
      if (selectedPath === path && noteOwnerRef.current?.id !== selectedOwnerId) return;
      const remaining = tabs.filter((tab) => tab !== path);
      setTabs(remaining);
      if (selectedPath === path) {
        const next = remaining.at(-1);
        if (next !== undefined) await openNote(next);
        else {
          setSelectedPath(null); clearLoadedNote(); commitContent(''); setMetadata(null); mentionsPathRef.current = null;
          metadataRevisionRef.current = -1; backlinksRevisionRef.current = -1; mentionsRevisionRef.current = -1;
          setBacklinks([]); setMentions([]); setHistory([]);
        }
      }
    } finally { releaseTransition(); }
  }


  const commandRegistry = useMemo(() => [
    { id: 'new-note', label: '新建笔记', shortcut: '⌘N', shortcutKey: 'n', shift: false, run: () => { setCommandOpen(false); setNewNotePath(''); setNewNoteOpen(true); } },
    { id: 'open-switcher', label: '快速切换笔记与命令', shortcut: '⌘P / ⌘O', shortcutKey: 'p', shift: false, run: () => { setCommandOpen(true); setSwitcherQuery(''); } },
    { id: 'open-properties', label: '打开属性面板', shortcut: '', shortcutKey: '', shift: false, run: () => { onRequestToolChange?.('properties'); } },
    { id: 'reader', label: '切换到阅读视图', shortcut: '⌘⇧R', shortcutKey: 'r', shift: true, run: () => { setMode('read'); } },
    { id: 'live-preview', label: '切换到实时预览', shortcut: '⌘⇧M', shortcutKey: 'm', shift: true, run: () => { setMode('live'); } },
    { id: 'source', label: '切换到源码视图', shortcut: '⌘⇧U', shortcutKey: 'u', shift: true, run: () => { setMode('source'); } },
    { id: 'focus-search', label: '打开搜索', shortcut: '⌘K', shortcutKey: 'k', shift: false, run: () => { setCommandOpen(false); onSearchRequest?.(''); } },
  ], [onRequestToolChange, onSearchRequest]);

  const runCommand = useCallback((id: string): void => {
    const command = commandRegistry.find((item) => item.id === id);
    if (command === undefined) return;
    setRecentCommandIds((current) => {
      const next = [id, ...current.filter((recent) => recent !== id)].slice(0, 8);
      if (snapshot !== null) {
        try { window.localStorage.setItem(`noltri:vault-commands:${encodeURIComponent(snapshot.rootPath)}`, JSON.stringify(next)); } catch { /* Commands remain usable without local storage. */ }
      }
      return next;
    });
    command.run();
  }, [commandRegistry, snapshot]);

  const commandQuery = switcherQuery.trim().replace(/^>/, '').trim().toLocaleLowerCase();
  const commandRows = [...commandRegistry]
    .filter((command) => commandQuery === '' || fuzzyMatchRanges(commandQuery, command.label).length > 0)
    .sort((a, b) => {
      const aRecent = recentCommandIds.indexOf(a.id); const bRecent = recentCommandIds.indexOf(b.id);
      return (aRecent < 0 ? Number.MAX_SAFE_INTEGER : aRecent) - (bRecent < 0 ? Number.MAX_SAFE_INTEGER : bRecent);
    });

  const editorOwner = noteOwnerRef.current;

  useEffect(() => {
    if (!active) {
      modifierHeld.current = false;
      setCommandOpen(false);
      setSwitcherQuery('');
      setSwitcherResults([]);
      return;
    }
    const handleKey = (event: KeyboardEvent): void => {
      modifierHeld.current = event.metaKey || event.ctrlKey;
      if (!(event.metaKey || event.ctrlKey) || event.altKey) {
        if (event.key === 'Escape') { setCommandOpen(false); setPreviewTarget(null); }
        return;
      }
      const key = event.key.toLocaleLowerCase();
      const command = commandRegistry.find((item) => (item.shortcutKey === key || (item.id === 'open-switcher' && key === 'o')) && item.shift === event.shiftKey);
      if (command !== undefined) { event.preventDefault(); runCommand(command.id); }
    };
    const releaseModifier = (event: KeyboardEvent): void => { modifierHeld.current = event.metaKey || event.ctrlKey; };
    const clearModifier = (): void => { modifierHeld.current = false; };
    window.addEventListener('keydown', handleKey);
    window.addEventListener('keyup', releaseModifier);
    window.addEventListener('blur', clearModifier);
    return () => { window.removeEventListener('keydown', handleKey); window.removeEventListener('keyup', releaseModifier); window.removeEventListener('blur', clearModifier); };
  }, [active, commandRegistry, runCommand]);

  const restoreLocalDraft = useCallback((): void => {
    if (note === null) return;
    const owner = noteOwnerRef.current;
    if (owner === null || owner.path !== note.path || owner.rootPath !== rootPathRef.current) return;
    const root = owner.rootPath;
    const storedDraft = readDraftRecord(root, note.path);
    if (storedDraft === null) { setDraftAvailable(false); return; }
    const draft = storedDraft.content;
    const recovery = classifyVaultDraftRecovery(draft, storedDraft.metadata, note);
    if (recovery === 'discard') {
      if (draftWritesRef.current?.clear(root, note.path) === false) {
        setError('本机恢复草稿清除失败；恢复入口仍保留。');
        return;
      }
      setDraftAvailable(false);
      return;
    }
    setDraftAvailable(false);
    commitContent(draft);
    if (recovery === 'conflict') {
      setSaveState('conflict');
      setError('恢复草稿基于较旧的磁盘版本或此前发生过外部冲突。草稿已保留，不会自动覆盖磁盘内容；请复制草稿，或重新载入外部版本。');
    } else {
      setSaveState('dirty');
      setError(null);
    }
  }, [commitContent, note]);

  const emptyToolPanel = <p className="vault-tool-empty">选择一篇笔记以查看相关信息。</p>;
  const rightToolPanels: RightToolPanels = {
    outline: note === null ? emptyToolPanel : <div className="vault-outline-list">
      {headings.map((heading, index) => <button key={`${heading.heading}:${index}`} type="button" className={outlineCursor >= heading.position.start.offset && outlineCursor < (headings[index + 1]?.position.start.offset ?? Number.MAX_SAFE_INTEGER) ? 'is-active' : ''} style={{ '--level': heading.level } as React.CSSProperties} onClick={() => { setMode('read'); setJumpTo({ subpath: heading.heading, sourceOffset: heading.position.start.offset }); }}>{heading.heading}</button>)}
      {Object.values(metadata?.blocks ?? {}).map((block) => <div className="vault-block-row" key={block.id}><button type="button" onClick={() => { setMode('read'); setJumpTo({ subpath: `^${block.id}`, sourceOffset: block.position.start.offset }); }}>¶ ^{block.id}</button><button type="button" aria-label={`重命名块 ID ${block.id}`} onClick={() => void renameBlock(block.id)}>⋯</button></div>)}
      {headings.length === 0 && Object.keys(metadata?.blocks ?? {}).length === 0 ? <p>正文中还没有标题或块 ID。</p> : null}
    </div>,
    backlinks: note === null ? emptyToolPanel : <div className="vault-link-list">
      {backlinks.map((item) => <button type="button" key={item.sourcePath} onClick={() => onNavigateRequest?.(item.sourcePath)}><strong>{titleForPath(item.sourcePath)}</strong><small>{item.count} 处链接</small></button>)}
      {mentions.map((item) => <div className="vault-mention-row" key={`mention:${item.sourcePath}`}><button type="button" onClick={() => onNavigateRequest?.(item.sourcePath)}><strong>{titleForPath(item.sourcePath)}</strong><small>{item.positions.length} 处提及</small></button>{item.positions.slice(0, 3).map((position, index) => <button className="vault-convert-mention" type="button" key={index} onClick={() => void convertMention(item.sourcePath, position)}>转为链接</button>)}</div>)}
      {backlinks.length === 0 && mentions.length === 0 ? <p>暂无反向链接或未链接提及</p> : null}
    </div>,
    outgoing: note === null ? emptyToolPanel : <div className="vault-link-list">
      {(metadata?.links ?? []).filter((link) => link.kind !== 'frontmatter').map((link, index) => <button type="button" key={`${link.kind}:${link.position.start.offset}:${index}`} onClick={() => void openLink(link.link, note.path, link.kind as VaultLinkKind)}><strong>{link.displayText ?? link.link}</strong><small>{link.kind} · {link.link}</small></button>)}
      {(metadata?.links?.filter((link) => link.kind !== 'frontmatter').length ?? 0) === 0 ? <p>正文中还没有出链。</p> : null}
    </div>,
    tags: note === null ? emptyToolPanel : <div className="vault-tag-list">
      {tags.map((tag) => <button className="vault-tag-chip" key={tag} type="button" onClick={() => onSearchRequest?.(`tag:${tag}`)}>#{tag}<small>{vaultTagCounts.get(tag) ?? tagCounts.get(tag)}</small></button>)}
      {tags.length === 0 ? <p>尚无标签</p> : null}
    </div>,
    properties: note === null ? emptyToolPanel : <>
      <PropertyPanel key={editorOwner?.id ?? note.path} hiddenKeys={isCanonicalSemanticPath(note.path) ? [...graphNoteSystemProperties] : []} onUpdateSafetyChange={reportPropertyUpdateSafety} content={content} metadata={metadata} propertyTypes={vaultSettings.propertyTypes ?? {}} disabled={!settingsReady || settingsBusy} onTypeChange={(key, type, current) => void updatePropertyType(key, type, current)} onUpdate={(key, value) => void updateProperty(key, value)} />
      <HistoryPanel api={api} path={note.path} current={content} versions={history} onRestore={(id) => void restoreVersion(id)} />
      <div className="vault-trust-settings"><strong>安全与信任</strong><label><input type="checkbox" checked={trust.html} onChange={(event) => setTrustValue({ ...trust, html: event.target.checked })} />允许渲染已清理的 HTML</label><small>脚本和事件属性始终被移除；设置仅作用于当前笔记库。</small><label><input type="checkbox" checked={trust.mermaid} onChange={(event) => setTrustValue({ ...trust, mermaid: event.target.checked })} />信任 Mermaid 图表</label><strong>新建链接格式</strong><label className="vault-setting-row"><select aria-label="新建链接格式" value={vaultSettings.newLinkFormat} disabled={!settingsReady || settingsBusy || snapshot === null} onChange={(event) => void updateLinkFormat(event.target.value as VaultSettings['newLinkFormat'])}><option value="shortest">最短路径</option><option value="relative">相对路径</option><option value="absolute">笔记库绝对路径</option></select></label>{settingsBusy ? <small role="status">正在同步笔记库设置…</small> : null}{settingsError !== null ? <small className="vault-setting-error" role="alert">笔记库设置未保存：{settingsError}</small> : null}</div>
    </>,
  };
  const interpretationPanel = note === null ? emptyToolPanel : <NoteInterpretationPanel key={editorOwner?.id ?? note.path} api={api} path={note.path} content={content} onUpdateSafetyChange={handleInterpretationUpdateSafety} onReturnToSource={() => { returnToTextRef.current(); setMode('source'); requestAnimationFrame(() => { const column = noteContentColumnRef.current; const source = column?.querySelector<HTMLElement>('.cm-content[contenteditable="true"]'); source?.focus({ preventScroll: true }); if (source === null || document.activeElement !== source) column?.focus({ preventScroll: true }); }); }} />;
  const canonicalIdentityForEditor = note === null ? undefined : semanticIdentityByPathRef.current.get(note.path);
  const rightPanelSignature = JSON.stringify([note?.path, content, metadata?.headings, metadata?.links, metadata?.blocks, backlinks, mentions, history, tags, vaultSettings, settingsReady, settingsBusy, settingsError, trust, saveState]);
  useEffect(() => onRightPanelContentChange?.({ toolPanels: rightToolPanels, interpretationPanel }, rightPanelSignature));

  return <div className={`vault-notes${active ? '' : ' vault-notes-hidden'}`} role="region" aria-label="笔记工作区">
    <main className="vault-note-main" data-note-path={note?.path} data-note-identity={note === null ? undefined : canonicalIdentityForEditor !== undefined ? `${canonicalIdentityForEditor.topicId}:${canonicalIdentityForEditor.chapterId ?? 'overview'}` : isCanonicalSemanticPath(note.path) ? `${String(note.metadata?.frontmatter?.topicId ?? '')}:${String(note.metadata?.frontmatter?.chapterId ?? 'overview')}` : `file:${note.path}`}>
      {displayMode === 'cards' ? <><div className="vault-card-actions"><button type="button" className="button-soft" onClick={() => { setNewNotePath(''); setNewNoteOpen(true); }}>＋ 新建 Markdown 笔记</button>{deletedPaths.length > 0 ? <button type="button" className="button-soft" onClick={() => setShowDeletedHistory(true)} aria-label={`恢复已删除项目，${deletedPaths.length} 项`}>恢复已删除项目 · {deletedPaths.length}</button> : null}</div>{contentView ?? <div className="vault-empty-note"><h1>{scopeTitle ?? '全部资料'}</h1><p>当前范围没有可显示的资料。</p></div>}</> : note === null ? <div className="vault-empty-layout"><div className="vault-empty-note">
        <div className="vault-empty-icon">知</div><h1>{snapshot === null ? '正在打开本机笔记' : scopeTitle ?? '选择一篇 Markdown 笔记'}</h1>
        <p>{snapshot === null ? '正在读取资料库中的 Markdown 文件。' : '从左侧学科导航或全部资料卡片选择一篇笔记。'}</p>
        <div><button type="button" className="button-primary" onClick={() => { setNewNotePath(''); setNewNoteOpen(true); }}>新建笔记</button></div>
        {error !== null ? <p className="vault-error" role="alert">{error}</p> : null}
      </div></div> : <>
        <header className="vault-note-header">
          <div className="vault-note-breadcrumb"><span>本机笔记</span><span>/</span><strong title={note.path}>{displayTitlesByPath.get(note.path) ?? titleForPath(note.path, note.metadata?.frontmatter)}</strong></div>
          <div className="vault-note-actions"><span className={`vault-save-indicator save-${saveState}`} role="status">{saveState === 'saving' ? '保存中…' : saveState === 'saved' ? '已保存' : saveState === 'dirty' ? '未保存' : saveState === 'conflict' ? '外部冲突' : '保存失败'}</span>
            <button type="button" className="vault-icon-button" title={isCanonicalSemanticPath(note.path) ? '主题笔记路径由知识内容维护' : '重命名'} disabled={isCanonicalSemanticPath(note.path)} onClick={() => setRenamePath(note.path)}>✎</button>
            <button type="button" className="vault-icon-button" title={isCanonicalSemanticPath(note.path) ? '主题笔记路径由知识内容维护' : '删除'} disabled={isCanonicalSemanticPath(note.path)} onClick={() => void deleteCurrent()}>⌫</button>
            {deletedPaths.length > 0 ? <button type="button" className="vault-icon-button" title="恢复已删除项目" aria-label={`恢复已删除项目，${deletedPaths.length} 项`} onClick={() => setShowDeletedHistory(true)}>↶</button> : null}
            <button type="button" className="vault-icon-button" title="刷新文件" onClick={() => {
              if (hasUnsavedContent(note.path) && !window.confirm('将从磁盘重新载入；本机恢复草稿会保留。继续？')) return;
              void openNote(note.path, null, {}, true);
            }}>↻</button>
          </div>
        </header>
        {tabs.length > 0 ? <nav className="vault-note-tabs" aria-label="打开的笔记">{tabs.map((path) => { const title = displayTitlesByPath.get(path) ?? titleForPath(path); return <div className={path === selectedPath ? 'is-active' : ''} key={path}><button type="button" onClick={() => onNavigateRequest !== undefined ? onNavigateRequest(path) : void openNote(path)} title={path}>{title}</button><button type="button" aria-label={`关闭 ${title}`} onClick={() => void closeTab(path)}>×</button></div>; })}{splitNote !== null ? <span className="vault-split-indicator">分屏：{titleForPath(splitNote.path, splitNote.metadata?.frontmatter)}<button type="button" onClick={() => setSplitNote(null)} aria-label="关闭分屏">×</button></span> : null}</nav> : null}
        {error !== null ? <div className="vault-inline-error" role="alert"><span>{error}</span>{saveState === 'conflict' ? <button type="button" onClick={() => { if (window.confirm('保留在本机的草稿仍可恢复。重新载入磁盘版本？')) void openNote(note.path, null, {}, true); }}>重新载入外部版本</button> : null}<button type="button" onClick={() => setError(null)}>关闭</button></div> : null}
        {draftAvailable ? <div className="vault-draft-recovery" role="status"><span>发现本机恢复草稿</span><button type="button" onClick={restoreLocalDraft}>恢复</button><button type="button" onClick={() => { const owner = noteOwnerRef.current; if (owner !== null && owner.path === note.path && draftWritesRef.current?.clear(owner.rootPath, note.path) !== false) setDraftAvailable(false); else setError('本机恢复草稿清除失败；恢复入口仍保留。'); }}>丢弃</button></div> : null}
        {renamePath !== '' ? <form className="vault-inline-form" onSubmit={(event) => { event.preventDefault(); void renameCurrent(); }}><label>新路径<input autoFocus value={renamePath} onChange={(event) => setRenamePath(event.target.value)} /></label><button className="button-primary" type="submit">重命名</button><button type="button" onClick={() => setRenamePath('')}>取消</button></form> : null}
        <NoteBodyPresentation
          content={content}
          path={note.path}
          textView={<>
            {wikiCompletion !== null && mode !== 'read' ? <div className="vault-wikilink-completions" role="listbox" aria-label="笔记链接候选"><span>链接到笔记</span>{linkSuggestions.map((target) => <button type="button" role="option" aria-selected="false" key={target.path} onMouseDown={(event) => event.preventDefault()} onClick={() => {
              const current = incompleteWikiLinkAt(contentRef.current, outlineCursor);
              if (current === null) return;
              const link = `[[/${target.path}|${target.title.replace(/[\]\r\n]/gu, ' ').trim()}]]`;
              commitContent(`${contentRef.current.slice(0, current.start)}${link}${contentRef.current.slice(current.end)}`);
              setOutlineCursor(current.start + link.length);
            }}><strong>{target.title}</strong><small>{target.path}</small></button>)}{linkSuggestions.length === 0 ? <small>没有匹配笔记；可以继续输入标题或手动填写路径。</small> : null}</div> : null}
            {mode === 'read' ? <NoteReader key={editorOwner?.id ?? note.path} content={content} path={note.path} api={api} trustedHtml={trust.html} trustMermaid={trust.mermaid} onOpenLink={(target, sourcePath, kind) => {
              if (editorOwner !== null && ownsNoteContext(editorOwner, note.path, editorOwner.id)) void openLink(target, sourcePath, kind);
            }} onHoverLink={(target, anchor, sourcePath, kind) => {
              if (editorOwner !== null && ownsNoteContext(editorOwner, note.path, editorOwner.id)) openPreview(target, anchor, sourcePath, kind);
            }} onLeaveLink={schedulePreviewClose} onTrustMermaid={() => {
              if (window.confirm('信任此笔记中的 Mermaid 图表？只会对当前笔记库生效。')) setTrustValue({ ...trust, mermaid: true });
            }} jumpTo={jumpTo} /> : <NotesEditor
              key={editorOwner?.id ?? note.path}
              value={content}
              mode={mode}
              readOnly={transitioning}
              searchRanges={searchRanges}
              sourcePath={note.path}
              linkResolutionKey={`${snapshot?.rootPath ?? ''}:${snapshot?.revision ?? 0}`}
              trustedHtml={trust.html}
              trustMermaid={trust.mermaid}
              onTrustMermaid={() => {
                if (window.confirm('信任此笔记中的 Mermaid 图表？只会对当前笔记库生效。')) setTrustValue({ ...trust, mermaid: true });
              }}
              onChange={(value) => {
                if (editorOwner !== null && noteOwnerRef.current === editorOwner
                  && ownsNoteContext(editorOwner, note.path, editorOwner.id)) commitContent(value);
              }}
              onOpenLink={(target, sourcePath, kind) => {
                if (editorOwner !== null && noteOwnerRef.current === editorOwner
                  && ownsNoteContext(editorOwner, note.path, editorOwner.id)) void openLink(target, sourcePath, kind);
              }}
              onCursorChange={setOutlineCursor}
              jumpToSource={editorJumpRequest?.path === note.path ? editorJumpRequest : null}
              onHoverLink={(target, anchor, sourcePath, kind) => {
                if (editorOwner !== null && noteOwnerRef.current === editorOwner
                  && ownsNoteContext(editorOwner, note.path, editorOwner.id)) openPreview(target, anchor, sourcePath, kind);
              }}
              onLeaveLink={schedulePreviewClose}
              onResolveLink={async (target, sourcePath, kind) => {
                if (editorOwner === null || !ownsNoteContext(editorOwner, note.path, editorOwner.id)) return { path: null };
                const result = await api.resolveVaultLink(target, sourcePath, kind);
                return ownsNoteContext(editorOwner, note.path, editorOwner.id) ? result : { path: null };
              }}
              onLoadNote={async (path) => {
                if (editorOwner === null || !ownsNoteContext(editorOwner, note.path, editorOwner.id)) throw new Error('Vault context changed');
                const file = await api.vaultFile(path);
                if (!ownsNoteContext(editorOwner, note.path, editorOwner.id)) throw new Error('Vault context changed');
                return { content: file.content };
              }}
              onLoadAsset={async (path) => {
                if (editorOwner === null || !ownsNoteContext(editorOwner, note.path, editorOwner.id)) throw new Error('Vault context changed');
                const asset = await api.getVaultAsset(path);
                if (!ownsNoteContext(editorOwner, note.path, editorOwner.id)) throw new Error('Vault context changed');
                return { mimeType: asset.mimeType, dataUrl: asset.dataUrl };
              }}
            />}
</>}
          onLocate={(sourceOffset) => {
            if (mode === 'read') setJumpTo({ subpath: '', sourceOffset });
            else {
              setJumpTo(null);
              setEditorJumpRequest({ path: note.path, requestId: ++editorJumpRequestId.current, sourceOffset });
            }
          }}
        >{({ toggleButton, viewport, returnToText }) => { returnToTextRef.current = returnToText; return <>
        <div className="vault-editor-toolbar">
          <div className="vault-editor-toolbar-main">
          <div className="vault-mode-tabs" role="tablist" aria-label="笔记模式">
            {(['live', 'source', 'read'] as const).map((option) => <button key={option} type="button" role="tab" aria-selected={mode === option} className={mode === option ? 'is-active' : ''} onClick={() => setModeValue(option)}>{option === 'live' ? '实时预览' : option === 'source' ? '源码' : '阅读'}</button>)}
          </div>
          {toggleButton}
          </div>
          {transitioning ? <span className="vault-transition-status" role="status">正在保存并切换…</span> : null}
        </div>
        <div className={`vault-editor-layout${splitNote !== null ? ' has-split' : ''}`}>
          <section ref={noteContentColumnRef} className="vault-editor-column" aria-label="笔记内容" tabIndex={-1}>{viewport}</section>
          {splitNote !== null ? <section className="vault-split-column" aria-label={`分屏阅读 ${titleForPath(splitNote.path, splitNote.metadata?.frontmatter)}`}><header><strong title={splitNote.path}>{titleForPath(splitNote.path, splitNote.metadata?.frontmatter)}</strong><button type="button" onClick={() => setSplitNote(null)}>关闭</button></header><NoteReader content={splitNote.content} path={splitNote.path} api={api} trustedHtml={trust.html} trustMermaid={trust.mermaid} onOpenLink={trustedLink} onTrustMermaid={() => undefined} /></section> : null}
        </div>
        </>; }}
        </NoteBodyPresentation>
        {previewTarget !== null ? <div className="vault-hover-preview" style={{ left: Math.max(16, Math.min(window.innerWidth - 420, previewTarget.anchor.left)), top: Math.min(window.innerHeight - 300, previewTarget.anchor.bottom + 8) }} onMouseEnter={() => { if (previewTimer.current !== null) clearTimeout(previewTimer.current); }} onMouseLeave={schedulePreviewClose} role="dialog" aria-label={`预览 ${previewTarget.title}`}><strong>{previewTarget.title}</strong><NoteReader content={previewTarget.content} path={previewTarget.path} api={api} trustedHtml={trust.html} trustMermaid={trust.mermaid} onOpenLink={trustedLink} onTrustMermaid={() => undefined} /></div> : null}
      </>}
    </main>

    {newNoteOpen ? <div className="vault-modal-backdrop" role="presentation"><form className="vault-modal" onSubmit={(event) => { event.preventDefault(); void createNote(); }}><h2>新建 Markdown 笔记</h2><label>笔记库内路径<input autoFocus value={newNotePath} onChange={(event) => setNewNotePath(event.target.value)} placeholder="Inbox/新笔记.md" /></label><p>正文会保存为本机 Markdown 笔记。</p><div><button type="button" className="button-soft" onClick={() => setNewNoteOpen(false)}>取消</button><button type="submit" className="button-primary">创建</button></div></form></div> : null}
    {showDeletedHistory ? <div className="vault-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setShowDeletedHistory(false); }}><div className="vault-modal vault-deleted-paths" role="dialog" aria-modal="true" aria-label="恢复已删除项目"><h2>恢复已删除项目</h2><p>选择路径查看并恢复保留的历史版本。</p>{deletedPaths.map((path) => <button type="button" key={path} onClick={() => { setShowDeletedHistory(false); setRestorePath(path); }}>{path}</button>)}<div><button type="button" className="button-soft" onClick={() => setShowDeletedHistory(false)}>关闭</button></div></div></div> : null}
    {restorePath !== null ? <DeletedHistoryDialog api={api} path={restorePath} onClose={() => setRestorePath(null)} onRestore={(versionId) => void restoreDeletedPath(restorePath, versionId)} /> : null}
    {assetPreview !== null ? <div className="vault-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setAssetPreview(null); }}><div className="vault-asset-modal" role="dialog" aria-modal="true" aria-label={`附件 ${assetPreview.path}`}><header><strong>{assetPreview.path}</strong><button type="button" onClick={() => setAssetPreview(null)} aria-label="关闭附件预览">×</button></header>{assetPreview.mimeType.startsWith('image/') ? <img src={assetPreview.dataUrl} alt={assetPreview.path} /> : assetPreview.mimeType.startsWith('audio/') ? <audio controls src={assetPreview.dataUrl} /> : assetPreview.mimeType.startsWith('video/') ? <video controls src={assetPreview.dataUrl} /> : <a href={assetPreview.dataUrl} download={assetPreview.path.split('/').at(-1)}>下载附件</a>}</div></div> : null}
    {commandOpen ? <div className="vault-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setCommandOpen(false); }}><div className="vault-command-modal" role="dialog" aria-modal="true" aria-label="命令面板"><label><span>⌕</span><input autoFocus value={switcherQuery} onChange={(event) => setSwitcherQuery(event.target.value)} placeholder="输入 > 筛选命令，或搜索笔记…" /></label><div className="vault-command-results">
      {commandRows.map((command) => <button type="button" key={command.id} onClick={() => runCommand(command.id)}><strong><FuzzyText value={command.label} query={commandQuery} /></strong><small>{command.shortcut || (recentCommandIds.includes(command.id) ? '最近使用' : '')}</small></button>)}
      {visibleSwitcherResults.map((result) => { const title = titleForPath(result.path); const titleMatches = fuzzyMatchRanges(switcherQuery, title).length > 0; return <button type="button" key={result.path} onClick={() => { setCommandOpen(false); if (onNavigateRequest !== undefined) onNavigateRequest(result.path); else void openNote(result.path); }}><strong><FuzzyText value={titleMatches ? title : result.path} query={switcherQuery} /></strong><small>{titleMatches ? result.path : '匹配路径'}</small></button>; })}
    </div></div></div> : null}
  </div>;
}

function PropertyPanel({ content, hiddenKeys = [], propertyTypes, disabled, onTypeChange, onUpdate, onUpdateSafetyChange }: { onUpdateSafetyChange?: (safe: boolean) => void; content: string; metadata: CachedNoteMetadata | null; hiddenKeys?: readonly string[]; propertyTypes: Record<string, PropertyType>; disabled: boolean; onTypeChange: (key: string, type: PropertyType, current: unknown) => void; onUpdate: (key: string, value: unknown) => void }): ReactElement {
  const frontmatter = readFrontmatter(content);
  const visibleProperties = Object.entries(frontmatter).filter(([name]) => !hiddenKeys.includes(name));
  const [yamlDrafts, setYamlDrafts] = useState<Record<string, string>>({});
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [protectedKeyAttempt, setProtectedKeyAttempt] = useState(false);
  const yamlMatches = (raw: string, value: unknown): boolean => {
    try { return JSON.stringify(YAML.parse(raw)) === JSON.stringify(value); } catch { return false; }
  };
  const yamlDirty = Object.entries(yamlDrafts).some(([name, raw]) => !yamlMatches(raw, frontmatter[name]));
  useEffect(() => { onUpdateSafetyChange?.(key === '' && value === '' && !yamlDirty); }, [key, value, yamlDirty, onUpdateSafetyChange]);
  useEffect(() => () => { onUpdateSafetyChange?.(true); }, [onUpdateSafetyChange]);
  useEffect(() => {
    // A saved/committed field may release its buffer; unrelated edits never erase invalid YAML.
    setYamlDrafts(previous => Object.fromEntries(Object.entries(previous).filter(([name, raw]) => !yamlMatches(raw, frontmatter[name]))));
  }, [content]);

  function discardYamlDraft(name: string): void {
    // An explicit delete/type conversion consumes only this field's scratch, never another field's input.
    setYamlDrafts(previous => { const next = { ...previous }; delete next[name]; return next; });
  }

  function typeFor(current: unknown): PropertyType {
    if (Array.isArray(current)) return 'list';
    if (typeof current === 'number') return 'number';
    if (typeof current === 'boolean') return 'boolean';
    if (current !== null && typeof current === 'object') return 'yaml';
    return 'text';
  }

  return <div className="vault-properties">
    {visibleProperties.map(([name, current]) => { const selectedType = propertyTypes[name] ?? typeFor(current); const yamlDraft = yamlDrafts[name]; let yamlValid = true; if (yamlDraft !== undefined) { try { YAML.parse(yamlDraft); } catch { yamlValid = false; } } return <label className="vault-property-row" key={name}><span>{name}<small>{selectedType}</small></span>
      <select aria-label={`${name} 属性类型`} value={selectedType} disabled={disabled} onChange={(event) => { const type = event.target.value as PropertyType; if (type !== 'yaml') discardYamlDraft(name); onTypeChange(name, type, current); }}><option value="text">文本</option><option value="number">数字</option><option value="boolean">布尔</option><option value="list">列表</option><option value="yaml">YAML</option></select>
      {selectedType === 'boolean' ? <input type="checkbox" checked={Boolean(current)} onChange={(event) => onUpdate(name, event.target.checked)} /> : selectedType === 'number' ? <input type="number" value={typeof current === 'number' ? current : Number(current) || 0} onChange={(event) => onUpdate(name, Number(event.target.value))} /> : selectedType === 'list' ? <input value={Array.isArray(current) ? current.join(', ') : String(current ?? '')} onChange={(event) => onUpdate(name, event.target.value.split(',').map((part) => part.trim()).filter(Boolean))} /> : selectedType === 'yaml' ? <><textarea aria-invalid={!yamlValid} value={yamlDraft ?? YAML.stringify(current)} onChange={(event) => { const raw = event.target.value; setYamlDrafts((drafts) => ({ ...drafts, [name]: raw })); try { onUpdate(name, YAML.parse(raw)); } catch { /* Keep the in-progress YAML text until it parses. */ } }} />{!yamlValid ? <small role="status">YAML 格式尚未完整</small> : null}</> : <input value={String(current ?? '')} onChange={(event) => onUpdate(name, String(event.target.value))} />}
      <button type="button" aria-label={`删除属性 ${name}`} onClick={() => { discardYamlDraft(name); onUpdate(name, undefined); }}>×</button>
    </label>; })}
    <form onSubmit={(event) => { event.preventDefault(); if (!key.trim()) return; if (hiddenKeys.includes(key.trim())) { setProtectedKeyAttempt(true); return; } onUpdate(key.trim(), value); setKey(''); setValue(''); setProtectedKeyAttempt(false); }}><input value={key} onChange={(event) => { setKey(event.target.value); setProtectedKeyAttempt(false); }} placeholder="属性名" aria-label="新属性名称" /><input value={value} onChange={(event) => setValue(event.target.value)} placeholder="值" aria-label="新属性值" /><button type="submit">＋</button></form>
    {protectedKeyAttempt ? <p role="alert">系统属性由知识库维护，不能手动添加。</p> : null}
    {visibleProperties.length === 0 ? <p>添加属性会写入 Markdown YAML frontmatter。</p> : null}
  </div>;
}

function FuzzyText({ value, query = '', ranges: exactRanges }: { value: string; query?: string; ranges?: readonly TextRange[] }): ReactElement {
  const ranges = normalizeTextRanges(exactRanges ?? fuzzyMatchRanges(query, value), value.length);
  if (ranges.length === 0) return <>{value}</>;
  const pieces: ReactElement[] = [];
  let offset = 0;
  ranges.forEach((range, index) => {
    if (range.start > offset) pieces.push(<span key={`text-${index}`}>{value.slice(offset, range.start)}</span>);
    pieces.push(<mark className="vault-fuzzy-hit" key={`hit-${index}`}>{value.slice(range.start, range.end)}</mark>);
    offset = range.end;
  });
  if (offset < value.length) pieces.push(<span key="tail">{value.slice(offset)}</span>);
  return <>{pieces}</>;
}

function readFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (match === null) return {};
  try { const parsed: unknown = YAML.parse(match[1]!); return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
  catch { return {}; }
}

function HistoryPanel({ api, path, current, versions, onRestore, previewable = true }: { api: WorkbenchApi; path: string; current: string; versions: NoteHistoryResponse['versions']; onRestore: (id: string) => void; previewable?: boolean }): ReactElement {
  const [selected, setSelected] = useState<{ id: string; content: string } | null>(null);
  const [loading, setLoading] = useState(false);
  async function inspect(id: string): Promise<void> {
    setLoading(true);
    try { const version = await api.vaultHistoryVersion(path, id); setSelected({ id, content: version.content }); }
    catch { setSelected({ id, content: '无法读取该历史版本。' }); }
    finally { setLoading(false); }
  }
  return <div className="vault-history-panel"><div className="vault-history-list">{versions.map((version) => <div key={version.id}><button type="button" disabled={!previewable} onClick={() => void inspect(version.id)}>{new Date(version.createdAt).toLocaleString()}</button><button type="button" onClick={() => onRestore(version.id)}>恢复</button></div>)}{versions.length === 0 ? <p>暂无历史版本</p> : null}{!previewable && versions.length > 0 ? <p>二进制附件保留原字节，可恢复但不能预览。</p> : null}</div>
    {loading ? <p>读取版本…</p> : selected !== null ? <div className="vault-history-diff"><strong>版本差异</strong><pre>{historyDiffLines(current, selected.content).map((line, index) => <span className={`diff-${line.kind}`} key={`${index}:${line.kind}`}>{line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : line.kind === 'context' ? '  ' : ''}{line.text || '\u00a0'}</span>)}</pre></div> : null}
  </div>;
}

function DeletedHistoryDialog({ api, path, onClose, onRestore }: { api: WorkbenchApi; path: string; onClose: () => void; onRestore: (versionId: string) => void }): ReactElement {
  const [versions, setVersions] = useState<NoteHistoryResponse['versions']>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api.vaultHistory(path).then((response) => { if (!cancelled) setVersions(response.versions); }).catch((cause) => { if (!cancelled) setError(errorText(cause)); });
    return () => { cancelled = true; };
  }, [api, path]);
  return <div className="vault-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="vault-modal vault-deleted-history" role="dialog" aria-modal="true" aria-label={`恢复 ${path} 历史版本`}>
    <h2>已删除项目历史</h2><p>{path}</p>{error !== null ? <p role="alert">{error}</p> : <HistoryPanel api={api} path={path} current="" versions={versions} onRestore={onRestore} previewable={/\.md$/i.test(path)} />}
    <div><button type="button" className="button-soft" onClick={onClose}>关闭</button></div>
  </div></div>;
}
