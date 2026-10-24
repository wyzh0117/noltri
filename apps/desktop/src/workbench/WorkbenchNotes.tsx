import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { CachedNoteMetadata, NoteFile, NoteHistoryResponse, NoteSearchResponse, VaultEntry, VaultSettings, VaultSnapshot } from '@noltri/schema';
import YAML from 'yaml';
import { describeError } from './api';
import type { WorkbenchApi } from './api';
import { NotesEditor } from './NotesEditor';
import { classifyNoteChange, classifyVaultDraftRecovery, createVaultDraftWriteQueue, decodeVaultDraftRecord, drainNoteFlush, extractSubpath, fuzzyMatchRanges, groupMarkdownTokens, historyDiffLines, markdownBlockRanges, markdownReaderTarget, movedMarkdownHistoryPaths, normalizeTextRanges, remapVaultPath, replaceMentionAt, safeDecodeVaultFragment, safeNoteHref, saveLatestNoteWithEtag, setFrontmatterProperty, vaultContextMatches, vaultLinkPathCandidates, vaultPathContextMatches, vaultPathContains, writeVaultDraftRecord } from './notes-model';
import type { TextRange, VaultContextIdentity, VaultDraftMetadata } from './notes-model';
import './notes-workbench.css';

type EditorMode = 'live' | 'source' | 'read';
type NotePanel = 'outline' | 'tags' | 'properties' | 'backlinks' | 'mentions' | 'history';
type SaveState = 'saved' | 'saving' | 'dirty' | 'conflict' | 'error';
type VaultLinkKind = 'wikilink' | 'markdown';

interface WorkbenchNotesProps {
  api: WorkbenchApi;
  active: boolean;
  requestedOpen: { path: string; intent: { newTab: boolean; split: boolean }; id: number } | null;
  previewRequest?: { path: string; anchor: DOMRect | null; id: number } | null;
  tagQuery: string | null;
  vaultTagCounts: ReadonlyMap<string, number>;
  onContextChange: (rootPath: string, selectedPath: string | null, revision: number) => void;
}

interface TrustSettings { html: boolean; mermaid: boolean }
interface LoadedNoteOwner extends VaultContextIdentity { path: string; id: number }

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

function parentPath(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
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
              return `<pre class="vault-mermaid-block"><code>${code}</code><button type="button" data-noltri-trust-mermaid>信任此 Vault 并渲染 Mermaid</button></pre>`;
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
      if (anchor !== undefined && anchor !== null) { anchor.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
      attempts += 1;
        if (attempts < 40) window.setTimeout(reveal, 40);
      };
      window.setTimeout(reveal, 120);
    })();
    return () => { cancelled = true; };
  }, [api, body, content, jumpTo, path, preparedReader]);
  const sections = preparedReader?.sections ?? null;
  return <div ref={scrollRef} className="vault-reader-scroll">
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

function entryTree(entries: readonly VaultEntry[]): Array<VaultEntry & { depth: number }> {
  const sorted = sortedEntries(entries);
  const folders = new Set(sorted.filter((entry) => entry.kind === 'folder').map((entry) => entry.path));
  const implicit = new Set<string>();
  for (const entry of sorted) {
    let parent = parentPath(entry.path);
    while (parent !== '') { implicit.add(parent); parent = parentPath(parent); }
  }
  const all = new Map<string, VaultEntry>();
  for (const folder of implicit) if (!folders.has(folder)) all.set(folder, { path: folder, name: basename(folder), kind: 'folder' });
  for (const entry of sorted) all.set(entry.path, entry);
  const childrenByParent = new Map<string, VaultEntry[]>();
  for (const entry of all.values()) {
    const parent = parentPath(entry.path);
    const children = childrenByParent.get(parent);
    if (children === undefined) childrenByParent.set(parent, [entry]);
    else children.push(entry);
  }
  const sortChildren = (children: VaultEntry[]): void => {
    children.sort((a, b) => Number(a.kind !== 'folder') - Number(b.kind !== 'folder')
      || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  };
  for (const children of childrenByParent.values()) sortChildren(children);
  const result: Array<VaultEntry & { depth: number }> = [];
  const visit = (folder: string, depth: number): void => {
    const children = childrenByParent.get(folder) ?? [];
    for (const entry of children) {
      result.push({ ...entry, depth });
      if (entry.kind === 'folder') visit(entry.path, depth + 1);
    }
  };
  visit('', 0);
  return result;
}

export function WorkbenchNotes({ api, active, requestedOpen, previewRequest = null, tagQuery, vaultTagCounts, onContextChange }: WorkbenchNotesProps): ReactElement {
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [tabs, setTabs] = useState<string[]>([]);
  const [splitNote, setSplitNote] = useState<NoteFile | null>(null);
  const [note, setNote] = useState<NoteFile | null>(null);
  const [content, setContent] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [transitioning, setTransitioning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rootInput, setRootInput] = useState('');
  const [showRootPicker, setShowRootPicker] = useState(false);
  const [mode, setMode] = useState<EditorMode>('live');
  const [panel, setPanel] = useState<NotePanel>('outline');
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
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderPath, setNewFolderPath] = useState('');
  const [treeRenameEntry, setTreeRenameEntry] = useState<VaultEntry | null>(null);
  const [treeRenamePath, setTreeRenamePath] = useState('');
  const [deletedPaths, setDeletedPaths] = useState<string[]>([]);
  const [showDeletedHistory, setShowDeletedHistory] = useState(false);
  const [restorePath, setRestorePath] = useState<string | null>(null);
  const [renamePath, setRenamePath] = useState('');
  const [outlineCursor, setOutlineCursor] = useState(0);
  const [trust, setTrust] = useState<TrustSettings>({ html: false, mermaid: false });
  const [vaultSettings, setVaultSettings] = useState<VaultSettings>({ newLinkFormat: 'shortest' });
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [draftAvailable, setDraftAvailable] = useState(false);
  const [jumpTo, setJumpTo] = useState<ReaderJumpTarget | null>(null);
  const [previewTarget, setPreviewTarget] = useState<{ path: string; title: string; content: string; anchor: DOMRect } | null>(null);
  const [assetPreview, setAssetPreview] = useState<{ path: string; mimeType: string; dataUrl: string } | null>(null);
  const [diagnostics, setDiagnostics] = useState<Awaited<ReturnType<WorkbenchApi['vaultDiagnostics']>> | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const saveTimer = useRef<number | null>(null);
  const revisionRef = useRef(0);
  const noteRef = useRef<NoteFile | null>(null);
  const contentRef = useRef(content);
  const rootPathRef = useRef<string | null>(snapshot?.rootPath ?? null);
  const vaultEpochRef = useRef(0);
  const noteOwnerRef = useRef<LoadedNoteOwner | null>(null);
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
        : '本机恢复草稿未能写入或清除；Vault 保存状态见上方（非冲突时自动保存仍可继续）。请复制重要内容。');
    },
  );
  const pendingWritesRef = useRef(new Map<string, number>());
  const deferredChangesRef = useRef(new Set<string>());
  const changesPollInFlightRef = useRef(false);
  const contextPathRef = useRef<string | null>(null);
  const mentionsPathRef = useRef<string | null>(null);
  const previewTimer = useRef<number | null>(null);
  const previewOpenTimer = useRef<number | null>(null);
  const modifierHeld = useRef(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const lastOpenRequestId = useRef<number | null>(null);
  const noteLoadRequestId = useRef(0);
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

  const commitContent = useCallback((value: string): void => {
    contentRef.current = value;
    setContent(value);
  }, []);
  const hasUnsavedContent = useCallback((path = noteRef.current?.path): boolean => {
    const current = noteRef.current;
    return path !== undefined && current?.path === path && contentRef.current !== current.content;
  }, []);

  const publishContext = useCallback((next: VaultSnapshot | null, path: string | null): void => {
    if (next !== null) onContextChange(next.rootPath, path, next.revision);
  }, [onContextChange]);

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
      publishContext(next, contextPathRef.current);
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

  useEffect(() => {
    if (snapshot === null) { setDeletedPaths([]); return; }
    try {
      const raw = window.localStorage.getItem(`noltri:vault-deleted:${encodeURIComponent(snapshot.rootPath)}`);
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      setDeletedPaths(Array.isArray(parsed) ? parsed.filter((path): path is string => typeof path === 'string') : []);
    } catch { setDeletedPaths([]); }
  }, [snapshot?.rootPath]);

  useEffect(() => {
    if (!active || snapshot === null) return undefined;
    let cancelled = false;
    const refresh = (): void => { void api.vaultDiagnostics().then((value) => { if (!cancelled) setDiagnostics(value); }).catch(() => undefined); };
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [active, api, snapshot?.rootPath]);

  useEffect(() => {
    if (previewRequest === null) return;
    if (previewRequest.anchor === null) { schedulePreviewClose(); return; }
    if (previewTimer.current !== null) clearTimeout(previewTimer.current);
    if (previewOpenTimer.current !== null) clearTimeout(previewOpenTimer.current);
    let cancelled = false;
    void api.vaultFile(previewRequest.path).then((file) => {
      if (!cancelled) setPreviewTarget({ path: file.path, title: basename(file.path), content: file.content, anchor: previewRequest.anchor! });
    }).catch(() => { if (!cancelled) setPreviewTarget(null); });
    return () => { cancelled = true; };
  }, [api, previewRequest?.id]);

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
    let cancelled = false;
    setSettingsBusy(true);
    setSettingsError(null);
    void api.vaultSettings().then((value) => {
      if (!cancelled) setVaultSettings(value);
    }).catch((cause) => {
      if (!cancelled) setSettingsError(errorText(cause));
    }).finally(() => {
      if (!cancelled) setSettingsBusy(false);
    });
    return () => { cancelled = true; };
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
    if (snapshot !== null) publishContext(snapshot, selectedPath);
    contextPathRef.current = selectedPath;
  }, [snapshot, selectedPath, publishContext]);

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
        const outcome = await saveLatestNoteWithEtag((input) => api.saveVaultFile(input, root), path, () => {
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
  }, [api, ownsNoteContext, reconcileChangedPath, selectedPath, snapshot?.rootPath, updateLoadedNote]);

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
      setMetadata(null); setBacklinks([]); setMentions([]); setHistory([]);
      setDraftAvailable(getDraft(requestContext.rootPath, path) !== null);
      setJumpTo(subpath ?? null);
      publishContext(snapshot, path);
      const [meta, back, mention, versions] = await Promise.allSettled([
        api.vaultMetadata(path), api.vaultBacklinks(path), api.vaultMentions(path), api.vaultHistory(path),
      ]);
      if (requestId !== noteLoadRequestId.current || !ownsNoteContext(requestContext, path, ownerId)
        || contextPathRef.current !== path) return;
      setMetadata(meta.status === 'fulfilled' ? meta.value.metadata : null);
      setBacklinks(back.status === 'fulfilled' ? back.value.backlinks : []);
      setMentions(mention.status === 'fulfilled' ? mention.value.mentions : []);
      setHistory(versions.status === 'fulfilled' ? versions.value.versions : []);
      mentionsPathRef.current = path;
    } catch (cause) { if (ownsVaultContext(requestContext)) setError(errorText(cause)); }
    finally { releaseTransition(); }
  }, [api, beginTransition, bindLoadedNote, captureVaultContext, commitContent, hasUnsavedContent, ownsNoteContext, ownsVaultContext, publishContext, saveCurrent, selectedPath, snapshot]);

  useEffect(() => {
    if (active && requestedOpen !== null && requestedOpen.id !== lastOpenRequestId.current) {
      lastOpenRequestId.current = requestedOpen.id;
      void openNote(requestedOpen.path, null, requestedOpen.intent);
    }
  }, [active, openNote, requestedOpen?.id]);

  useEffect(() => {
    if (tagQuery !== null && active) { setSearchQuery(tagQuery); setPanel('tags'); }
  }, [active, tagQuery]);

  useEffect(() => {
    if (!active || snapshot === null) return undefined;
    const context: VaultContextIdentity = { rootPath: snapshot.rootPath, epoch: vaultEpochRef.current };
    let cancelled = false;
    const checkChanges = async (): Promise<void> => {
      if (changesPollInFlightRef.current) return;
      changesPollInFlightRef.current = true;
      try {
        const changes = await api.vaultChanges(revisionRef.current);
        if (cancelled || !ownsVaultContext(context)) return;
        revisionRef.current = Math.max(revisionRef.current, changes.revision);
        if (changes.reset) { await reloadSnapshot(context); return; }
        if (changes.events.length === 0) return;
        const currentChanged = changes.events.some((event) => event.path === selectedPath);
        if (selectedPath !== null && currentChanged) {
          const changeKey = vaultChangeKey(snapshot.rootPath, selectedPath);
          if (pendingWritesRef.current.has(changeKey)) deferredChangesRef.current.add(changeKey);
          else await reconcileChangedPath(selectedPath, context);
        }
        await reloadSnapshot(context);
      } catch { /* Polling is best-effort; the next tick can recover. */ }
      finally { changesPollInFlightRef.current = false; }
    };
    const timer = window.setInterval(() => { void checkChanges(); }, 1400);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [active, api, ownsVaultContext, reconcileChangedPath, reloadSnapshot, selectedPath, snapshot]);

  const visibleEntries = useMemo(() => {
    if (snapshot === null) return [];
    return entryTree(snapshot.files).filter((entry) => {
      let parent = parentPath(entry.path);
      while (parent !== '') {
        if (collapsedFolders.has(parent)) return false;
        parent = parentPath(parent);
      }
      return true;
    });
  }, [collapsedFolders, snapshot]);
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
    if (panel !== 'outline') return;
    const activeHeading = document.querySelector<HTMLElement>('.vault-outline-list button.is-active');
    activeHeading?.scrollIntoView({ block: 'nearest' });
  }, [outlineCursor, panel, selectedPath]);

  async function changeVault(): Promise<void> {
    const rootPath = rootInput.trim();
    if (!rootPath) return;
    const requestContext = captureVaultContext();
    if (snapshot !== null && (requestContext === null || requestContext.rootPath !== snapshot.rootPath)) return;
    const requestEpoch = vaultEpochRef.current;
    const releaseTransition = beginTransition();
    try {
      const current = noteRef.current;
      if (current !== null && hasUnsavedContent(current.path) && !(await saveCurrent(current.path))) return;
      if (requestContext !== null ? !ownsVaultContext(requestContext) : rootPathRef.current !== null || vaultEpochRef.current !== requestEpoch) return;
      await Promise.all([...mentionWritesRef.current]);
      if (requestContext !== null ? !ownsVaultContext(requestContext) : rootPathRef.current !== null || vaultEpochRef.current !== requestEpoch) return;
      const next = await api.openVault({ rootPath });
      if (requestContext !== null ? !ownsVaultContext(requestContext) : rootPathRef.current !== null || vaultEpochRef.current !== requestEpoch) return;
      vaultEpochRef.current += 1;
      noteLoadRequestId.current += 1;
      splitLoadRequestId.current += 1;
      rootPathRef.current = next.rootPath;
      contextPathRef.current = null;
      mentionsPathRef.current = null;
      setSnapshot(next);
      revisionRef.current = next.revision;
      setSelectedPath(null); clearLoadedNote(); commitContent(''); setMetadata(null);
      mentionsPathRef.current = null; setBacklinks([]); setMentions([]); setHistory([]);
      setTabs([]); setSplitNote(null);
      setShowRootPicker(false); setShowDeletedHistory(false); setRestorePath(null); setTreeRenameEntry(null); setAssetPreview(null); setPreviewTarget(null); setCollapsedFolders(new Set()); setError(null); publishContext(next, null);
    } catch (cause) {
      const stillCurrent = requestContext !== null ? ownsVaultContext(requestContext)
        : rootPathRef.current === null && vaultEpochRef.current === requestEpoch;
      if (stillCurrent) setError(errorText(cause));
    }
    finally { releaseTransition(); }
  }

  async function createNote(): Promise<void> {
    const context = captureVaultContext();
    if (snapshot === null || context === null || snapshot.rootPath !== context.rootPath) return;
    const path = newNotePath.trim().replace(/^\/+/, '').replace(/\/+/g, '/');
    if (path === '' || path.includes('..') || path.startsWith('.')) { setError('请输入 Vault 内的相对路径，例如 Inbox/新笔记.md。'); return; }
    const finalPath = /\.md$/i.test(path) ? path : `${path}.md`;
    try {
      const created = await api.saveVaultFile({ path: finalPath, content: `# ${basename(finalPath)}\n\n` }, context.rootPath);
      if (!ownsVaultContext(context)) return;
      if (!await reloadSnapshot(context) || !ownsVaultContext(context)) return;
      setNewNoteOpen(false); setNewNotePath(''); await openNote(created.path);
    } catch (cause) { if (ownsVaultContext(context)) setError(errorText(cause)); }
  }

  async function createFolder(): Promise<void> {
    const context = captureVaultContext();
    if (context === null || snapshot?.rootPath !== context.rootPath) return;
    const path = newFolderPath.trim().replace(/^\/+/, '').replace(/\/+/g, '/');
    if (path === '' || path.includes('..') || path.startsWith('.')) { setError('请输入 Vault 内的相对文件夹路径。'); return; }
    try {
      await api.createVaultFolder({ path }, context.rootPath);
      if (!ownsVaultContext(context) || !await reloadSnapshot(context) || !ownsVaultContext(context)) return;
      setNewFolderOpen(false); setNewFolderPath('');
    } catch (cause) { if (ownsVaultContext(context)) setError(errorText(cause)); }
  }

  async function renameTreeEntry(): Promise<void> {
    const entry = treeRenameEntry;
    const context = captureVaultContext();
    const sourceSnapshot = snapshot;
    if (entry === null || sourceSnapshot === null || context === null || sourceSnapshot.rootPath !== context.rootPath) return;
    const newPath = treeRenamePath.trim().replace(/^\/+/, '').replace(/\/{2,}/g, '/');
    if (!newPath || newPath.split('/').some((part) => part === '.' || part === '..') || newPath === entry.path
      || (entry.kind === 'folder' && newPath.startsWith(`${entry.path}/`))) {
      setError('请输入有效的 Vault 内新路径。');
      return;
    }
    const releaseTransition = beginTransition();
    try {
      const current = noteRef.current;
      if (current !== null && !(await saveCurrent(current.path))) return;
      if (!ownsVaultContext(context)) return;
      const preview = await api.deletePreview(entry.path);
      if (!ownsVaultContext(context)) return;
      if (preview.kind !== entry.kind || (entry.kind === 'folder' && preview.descendantCount === undefined)) {
        setError('Core 没有返回匹配路径的安全路径预览，已取消改名。请更新 Core 后重试。');
        return;
      }
      const result = await api.renameVaultFile({ path: entry.path, newPath, expectedEtag: preview.etag }, context.rootPath);
      if (!ownsVaultContext(context)) return;
      rememberDeletedPaths(movedMarkdownHistoryPaths(sourceSnapshot.files, entry.path));
      const mappedTabs = tabs.map((path) => remapVaultPath(path, entry.path, result.path));
      setTabs(mappedTabs);
      setCollapsedFolders((paths) => new Set([...paths].map((path) => remapVaultPath(path, entry.path, result.path))));
      if (splitNote !== null && vaultPathContains(splitNote.path, entry.path)) {
        const file = await api.vaultFile(remapVaultPath(splitNote.path, entry.path, result.path));
        if (!ownsVaultContext(context)) return;
        setSplitNote(file);
      }
      setAssetPreview((asset) => asset !== null && vaultPathContains(asset.path, entry.path)
        ? { ...asset, path: remapVaultPath(asset.path, entry.path, result.path) }
        : asset);
      setTreeRenameEntry(null);
      if (!await reloadSnapshot(context) || !ownsVaultContext(context)) return;
      if (selectedPath !== null && vaultPathContains(selectedPath, entry.path)) {
        await openNote(remapVaultPath(selectedPath, entry.path, result.path), null, {}, true);
      }
    } catch (cause) { if (ownsVaultContext(context)) setError(errorText(cause)); }
    finally { releaseTransition(); }
  }

  async function deleteTreeEntry(entry: VaultEntry): Promise<void> {
    const context = captureVaultContext();
    const sourceSnapshot = snapshot;
    if (sourceSnapshot === null || context === null || sourceSnapshot.rootPath !== context.rootPath) return;
    const releaseTransition = beginTransition();
    try {
      const current = noteRef.current;
      if (current !== null && !(await saveCurrent(current.path))) return;
      if (!ownsVaultContext(context)) return;
      const preview = await api.deletePreview(entry.path);
      if (!ownsVaultContext(context)) return;
      if (preview.kind !== entry.kind) {
        setError('Core 没有返回匹配路径的安全删除预览，已取消删除。请更新 Core 后重试。');
        return;
      }
      const previewKind = preview.kind;
      if (previewKind === 'file' && current?.path === entry.path && preview.etag !== current.etag) {
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
      setCollapsedFolders((paths) => new Set([...paths].filter((path) => !vaultPathContains(path, entry.path))));
      setSplitNote((currentSplit) => currentSplit !== null && vaultPathContains(currentSplit.path, entry.path) ? null : currentSplit);
      setAssetPreview((asset) => asset !== null && vaultPathContains(asset.path, entry.path) ? null : asset);
      if (!await reloadSnapshot(context) || !ownsVaultContext(context)) return;
      if (selectedPath !== null && vaultPathContains(selectedPath, entry.path)) {
        noteLoadRequestId.current += 1;
        if (remaining.length > 0) await openNote(remaining.at(-1)!, null, {}, true);
        else {
          setSelectedPath(null); clearLoadedNote(); commitContent(''); setMetadata(null); setSaveState('saved');
          contextPathRef.current = null; mentionsPathRef.current = null; setBacklinks([]); setMentions([]); setHistory([]);
          publishContext(sourceSnapshot, null);
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
      if (/\.md$/i.test(path)) await openNote(path, null, {}, true);
    } catch (cause) { if (ownsVaultContext(context)) setError(errorText(cause)); }
    finally { releaseTransition(); }
  }

  async function renameCurrent(): Promise<void> {
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
      rememberDeletedPaths([path]);
      setRenamePath(''); setTabs((currentTabs) => currentTabs.map((tab) => tab === path ? next.path : tab));
      if (!await reloadSnapshot(context) || !ownsVaultContext(context)) return;
      await openNote(next.path);
    } catch (cause) { if (ownsNoteContext(context, path, owner.id)) setError(errorText(cause)); }
    finally { releaseTransition(); }
  }

  async function deleteCurrent(): Promise<void> {
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
        const nextContent = replaceMentionAt(fresh.content, position.start.offset, position.end.offset, basename(targetPath!), linkTarget);
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
    try { commitContent(setFrontmatterProperty(contentRef.current, key, value)); }
    catch (cause) { setError(errorText(cause)); }
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
    catch { setError('无法保存当前 Vault 的信任设置。'); }
  }

  async function updateLinkFormat(newLinkFormat: VaultSettings['newLinkFormat']): Promise<void> {
    const context = captureVaultContext();
    if (context === null || snapshot?.rootPath !== context.rootPath) return;
    setSettingsBusy(true);
    setSettingsError(null);
    try {
      const saved = await api.updateVaultSettings({ newLinkFormat }, context.rootPath);
      if (ownsVaultContext(context)) setVaultSettings(saved);
    } catch (cause) {
      if (ownsVaultContext(context)) setSettingsError(errorText(cause));
    } finally {
      if (ownsVaultContext(context)) setSettingsBusy(false);
    }
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
        setPreviewTarget({ path: resolved.path, title: basename(resolved.path), content: file.content, anchor });
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
        else { setSelectedPath(null); clearLoadedNote(); commitContent(''); setMetadata(null); mentionsPathRef.current = null; setBacklinks([]); setMentions([]); setHistory([]); }
      }
    } finally { releaseTransition(); }
  }

  async function openVaultEntry(entry: VaultEntry): Promise<void> {
    const context = captureVaultContext();
    if (context === null || snapshot?.rootPath !== context.rootPath) return;
    if (entry.kind === 'folder') return;
    if (entry.extension?.toLocaleLowerCase() === 'md') { await openNote(entry.path); return; }
    try {
      const asset = await api.getVaultAsset(entry.path);
      if (ownsVaultContext(context)) setAssetPreview(asset);
    } catch (cause) { if (ownsVaultContext(context)) setError(errorText(cause)); }
  }

  const commandRegistry = useMemo(() => [
    { id: 'new-note', label: '新建笔记', shortcut: '⌘N', shortcutKey: 'n', shift: false, run: () => { setCommandOpen(false); setNewNotePath(''); setNewNoteOpen(true); } },
    { id: 'open-switcher', label: '快速切换笔记与命令', shortcut: '⌘P / ⌘O', shortcutKey: 'p', shift: false, run: () => { setCommandOpen(true); setSwitcherQuery(''); } },
    { id: 'open-properties', label: '打开属性面板', shortcut: '', shortcutKey: '', shift: false, run: () => { setPanel('properties'); } },
    { id: 'reader', label: '切换到阅读视图', shortcut: '⌘⇧R', shortcutKey: 'r', shift: true, run: () => { setMode('read'); } },
    { id: 'live-preview', label: '切换到实时预览', shortcut: '⌘⇧M', shortcutKey: 'm', shift: true, run: () => { setMode('live'); } },
    { id: 'source', label: '切换到源码视图', shortcut: '⌘⇧U', shortcutKey: 'u', shift: true, run: () => { setMode('source'); } },
    { id: 'focus-search', label: '聚焦 Vault 搜索', shortcut: '⌘K', shortcutKey: 'k', shift: false, run: () => { searchInputRef.current?.focus(); } },
  ], []);

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

  return <div className={`vault-notes${active ? '' : ' vault-notes-hidden'}`}>
    <aside className="vault-file-sidebar" aria-label="Vault 文件导航">
      <div className="vault-sidebar-top">
        <div className="vault-root-label" title={snapshot?.rootPath ?? ''}>{snapshot?.rootPath ?? '正在读取 Vault…'}</div>
        <button type="button" className="vault-icon-button" aria-label="更换 Vault 文件夹" onClick={() => { setRootInput(snapshot?.rootPath ?? ''); setShowRootPicker((open) => !open); }}>⌂</button>
      </div>
      {showRootPicker ? <form className="vault-root-form" onSubmit={(event) => { event.preventDefault(); void changeVault(); }}>
        <label>Vault 文件夹路径<input autoFocus value={rootInput} onChange={(event) => setRootInput(event.target.value)} placeholder="/Users/you/Notes" /></label>
        <button className="button-primary" type="submit">打开</button>
      </form> : null}
      <label className="vault-search"><span aria-hidden="true">⌕</span><input ref={searchInputRef} value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索笔记…" aria-label="搜索 Vault" /><kbd>⌘K</kbd></label>
      {searchQuery.trim() !== '' ? <div className="vault-search-results" aria-label="搜索结果">
        {search?.results.map((result) => <button type="button" key={result.path} onClick={() => { void openNote(result.path); setSearchQuery(''); }}><strong><FuzzyText value={result.title} ranges={result.titleMatches} /></strong><small><FuzzyText value={result.path} ranges={result.matches.filter((match) => match.field === 'path')} /></small><span><FuzzyText value={result.snippet} ranges={result.snippetMatches} /></span></button>)}
        {search !== null && search.results.length === 0 ? <p>没有匹配笔记</p> : null}
      </div> : <>
        <div className="vault-tree-heading"><span>文件</span><div><button type="button" onClick={() => { setNewFolderPath(selectedPath ? parentPath(selectedPath) : ''); setNewFolderOpen(true); }}>▣ 文件夹</button><button type="button" onClick={() => { setNewNotePath(selectedPath ? `${parentPath(selectedPath) ? `${parentPath(selectedPath)}/` : ''}` : ''); setNewNoteOpen(true); }}>＋ 笔记</button></div></div>
        <nav className="vault-file-tree" aria-label="Vault 文件">
        {visibleEntries.map((entry) => <div className="vault-file-row-container" key={entry.path} style={{ '--depth': entry.depth } as React.CSSProperties}>
          <button type="button" className={`vault-file-row ${entry.path === selectedPath ? 'is-active' : ''} ${entry.kind === 'folder' ? 'is-folder' : ''}`} title={entry.path} aria-expanded={entry.kind === 'folder' ? !collapsedFolders.has(entry.path) : undefined} onClick={() => entry.kind === 'file' ? void openVaultEntry(entry) : setCollapsedFolders((current) => { const next = new Set(current); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; })}>
            <span aria-hidden="true">{entry.kind === 'folder' ? collapsedFolders.has(entry.path) ? '▸' : '⌄' : entry.extension?.toLocaleLowerCase() === 'md' ? '✎' : '◦'}</span><span>{entry.name}</span>
          </button>
          <details className="vault-file-row-menu"><summary aria-label={`${entry.path} 文件操作`} title="文件操作">⋯</summary><div>
            <button type="button" onClick={() => { setTreeRenameEntry(entry); setTreeRenamePath(entry.path); }}>重命名 / 移动</button>
            <button type="button" className="is-danger" onClick={() => void deleteTreeEntry(entry)}>删除</button>
          </div></details>
        </div>)}
          {visibleEntries.length === 0 ? <p className="vault-empty-tree">此 Vault 暂无文件。</p> : null}
        </nav>
      </>}
      {diagnostics !== null && (diagnostics.indexing || diagnostics.failedFiles.length > 0) ? <details className="vault-index-status">
        <summary role="status">{diagnostics.failedFiles.length > 0 ? `索引有 ${diagnostics.failedFiles.length} 项错误` : `正在索引 · 队列 ${diagnostics.queued}`}</summary>
        {diagnostics.failedFiles.map((failure) => <p key={failure.path}><strong>{failure.path}</strong><span>{failure.error}</span></p>)}
      </details> : null}
      <div className="vault-sidebar-footer"><button type="button" onClick={() => { setCommandOpen(true); setSwitcherQuery(''); }}>⌘ 命令面板 <kbd>⌘P</kbd></button><span>{snapshot?.files.filter((entry) => entry.kind === 'file' && entry.extension?.toLocaleLowerCase() === 'md').length ?? 0} 篇笔记</span>{deletedPaths.length > 0 ? <button type="button" onClick={() => setShowDeletedHistory(true)} aria-label={`恢复已删除项目，${deletedPaths.length} 项`}>恢复 · {deletedPaths.length}</button> : null}</div>
    </aside>

    <main className="vault-note-main">
      {note === null ? <div className="vault-empty-note">
        <div className="vault-empty-icon">知</div><h1>{snapshot === null ? '连接本地 Vault' : '让笔记彼此相连'}</h1>
        <p>{snapshot === null ? '正在读取本地 Markdown 文件夹。' : '从左侧打开一篇笔记，或创建新的 Markdown 文件。'}</p>
        <div><button type="button" className="button-primary" onClick={() => { setNewNotePath(''); setNewNoteOpen(true); }}>新建笔记</button><button type="button" className="button-soft" onClick={() => { setRootInput(snapshot?.rootPath ?? ''); setShowRootPicker(true); }}>打开 Vault</button></div>
        {error !== null ? <p className="vault-error" role="alert">{error}</p> : null}
      </div> : <>
        <header className="vault-note-header">
          <div className="vault-note-breadcrumb"><span>{snapshot?.rootPath.split('/').filter(Boolean).at(-1) ?? 'Vault'}</span><span>/</span><strong>{note.path}</strong></div>
          <div className="vault-note-actions"><span className={`vault-save-indicator save-${saveState}`} role="status">{saveState === 'saving' ? '保存中…' : saveState === 'saved' ? '已保存' : saveState === 'dirty' ? '未保存' : saveState === 'conflict' ? '外部冲突' : '保存失败'}</span>
            <button type="button" className="vault-icon-button" title="重命名" onClick={() => setRenamePath(note.path)}>✎</button>
            <button type="button" className="vault-icon-button" title="删除" onClick={() => void deleteCurrent()}>⌫</button>
            <button type="button" className="vault-icon-button" title="刷新文件" onClick={() => {
              if (hasUnsavedContent(note.path) && !window.confirm('将从磁盘重新载入；本机恢复草稿会保留。继续？')) return;
              void openNote(note.path, null, {}, true);
            }}>↻</button>
          </div>
        </header>
        {tabs.length > 0 ? <nav className="vault-note-tabs" aria-label="打开的笔记">{tabs.map((path) => <div className={path === selectedPath ? 'is-active' : ''} key={path}><button type="button" onClick={() => void openNote(path)} title={path}>{basename(path)}</button><button type="button" aria-label={`关闭 ${basename(path)}`} onClick={() => void closeTab(path)}>×</button></div>)}{splitNote !== null ? <span className="vault-split-indicator">分屏：{basename(splitNote.path)}<button type="button" onClick={() => setSplitNote(null)} aria-label="关闭分屏">×</button></span> : null}</nav> : null}
        {error !== null ? <div className="vault-inline-error" role="alert"><span>{error}</span>{saveState === 'conflict' ? <button type="button" onClick={() => { if (window.confirm('保留在本机的草稿仍可恢复。重新载入磁盘版本？')) void openNote(note.path, null, {}, true); }}>重新载入外部版本</button> : null}<button type="button" onClick={() => setError(null)}>关闭</button></div> : null}
        {draftAvailable ? <div className="vault-draft-recovery" role="status"><span>发现本机恢复草稿</span><button type="button" onClick={restoreLocalDraft}>恢复</button><button type="button" onClick={() => { const owner = noteOwnerRef.current; if (owner !== null && owner.path === note.path && draftWritesRef.current?.clear(owner.rootPath, note.path) !== false) setDraftAvailable(false); else setError('本机恢复草稿清除失败；恢复入口仍保留。'); }}>丢弃</button></div> : null}
        {renamePath !== '' ? <form className="vault-inline-form" onSubmit={(event) => { event.preventDefault(); void renameCurrent(); }}><label>新路径<input autoFocus value={renamePath} onChange={(event) => setRenamePath(event.target.value)} /></label><button className="button-primary" type="submit">重命名</button><button type="button" onClick={() => setRenamePath('')}>取消</button></form> : null}
        <div className="vault-editor-toolbar">
          <div className="vault-mode-tabs" role="tablist" aria-label="笔记模式">
            {(['live', 'source', 'read'] as const).map((option) => <button key={option} type="button" role="tab" aria-selected={mode === option} className={mode === option ? 'is-active' : ''} onClick={() => setModeValue(option)}>{option === 'live' ? '实时预览' : option === 'source' ? '源码' : '阅读'}</button>)}
          </div>
          {transitioning ? <span className="vault-transition-status" role="status">正在保存并切换…</span> : null}
          <button type="button" className="vault-panel-toggle" onClick={() => setPanel((current) => current === 'outline' ? 'properties' : 'outline')}>组织面板</button>
        </div>
        <div className={`vault-editor-layout panel-${panel}${splitNote !== null ? ' has-split' : ''}`}>
          <section className="vault-editor-column" aria-label="笔记内容">
            {mode === 'read' ? <NoteReader key={editorOwner?.id ?? note.path} content={content} path={note.path} api={api} trustedHtml={trust.html} trustMermaid={trust.mermaid} onOpenLink={(target, sourcePath, kind) => {
              if (editorOwner !== null && ownsNoteContext(editorOwner, note.path, editorOwner.id)) void openLink(target, sourcePath, kind);
            }} onHoverLink={(target, anchor, sourcePath, kind) => {
              if (editorOwner !== null && ownsNoteContext(editorOwner, note.path, editorOwner.id)) openPreview(target, anchor, sourcePath, kind);
            }} onLeaveLink={schedulePreviewClose} onTrustMermaid={() => {
              if (window.confirm('信任此 Vault 中的 Mermaid 图表？只会对当前 Vault 生效。')) setTrustValue({ ...trust, mermaid: true });
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
                if (window.confirm('信任此 Vault 中的 Mermaid 图表？只会对当前 Vault 生效。')) setTrustValue({ ...trust, mermaid: true });
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
          </section>
          {splitNote !== null ? <section className="vault-split-column" aria-label={`分屏阅读 ${splitNote.path}`}><header><strong>{basename(splitNote.path)}</strong><button type="button" onClick={() => setSplitNote(null)}>关闭</button></header><NoteReader content={splitNote.content} path={splitNote.path} api={api} trustedHtml={trust.html} trustMermaid={trust.mermaid} onOpenLink={trustedLink} onTrustMermaid={() => undefined} /></section> : null}
          <aside className="vault-organize-panel" aria-label="笔记组织工具">
            <div className="vault-organize-tabs">{(['outline', 'tags', 'properties', 'backlinks', 'mentions', 'history'] as const).map((item) => <button type="button" key={item} className={panel === item ? 'is-active' : ''} onClick={() => setPanel(item)}>{({ outline: '大纲', tags: '标签', properties: '属性', backlinks: '反链', mentions: '提及', history: '历史' } as const)[item]}</button>)}</div>
            {panel === 'outline' ? <div className="vault-outline-list">
              {headings.map((heading, index) => <button key={`${heading.heading}:${index}`} type="button" className={outlineCursor >= heading.position.start.offset && outlineCursor < (headings[index + 1]?.position.start.offset ?? Number.MAX_SAFE_INTEGER) ? 'is-active' : ''} style={{ '--level': heading.level } as React.CSSProperties} onClick={() => { setMode('read'); setJumpTo({ subpath: heading.heading, sourceOffset: heading.position.start.offset }); }}>{heading.heading}</button>)}
              {Object.values(metadata?.blocks ?? {}).map((block) => <div className="vault-block-row" key={block.id}><button type="button" onClick={() => { setMode('read'); setJumpTo({ subpath: `^${block.id}`, sourceOffset: block.position.start.offset }); }}>¶ ^{block.id}</button><button type="button" aria-label={`重命名块 ID ${block.id}`} onClick={() => void renameBlock(block.id)}>⋯</button></div>)}
            </div> : null}
            {panel === 'tags' ? <div className="vault-tag-list">{tags.map((tag) => <button key={tag} type="button" onClick={() => { setSearchQuery(`tag:${tag}`); }}><span>#</span>{tag}<small>{vaultTagCounts.get(tag) ?? tagCounts.get(tag)}</small></button>)}{tags.length === 0 ? <p>尚无标签</p> : null}</div> : null}
            {panel === 'properties' ? <PropertyPanel key={snapshot?.rootPath ?? ''} vaultRoot={snapshot?.rootPath ?? ''} content={content} metadata={metadata} onUpdate={(key, value) => void updateProperty(key, value)} /> : null}
            {panel === 'backlinks' ? <div className="vault-link-list">{backlinks.map((item) => <button type="button" key={item.sourcePath} onClick={() => void openNote(item.sourcePath)}><strong>{basename(item.sourcePath)}</strong><small>{item.count} 处链接</small></button>)}{backlinks.length === 0 ? <p>暂无反向链接</p> : null}</div> : null}
            {panel === 'mentions' ? <div className="vault-link-list">{mentions.map((item) => <div className="vault-mention-row" key={item.sourcePath}><button type="button" onClick={() => void openNote(item.sourcePath)}><strong>{basename(item.sourcePath)}</strong><small>{item.positions.length} 处提及</small></button>{item.positions.slice(0, 3).map((position, index) => <button className="vault-convert-mention" type="button" key={index} onClick={() => void convertMention(item.sourcePath, position)}>转为链接</button>)}</div>)}{mentions.length === 0 ? <p>暂无未链接提及</p> : null}</div> : null}
            {panel === 'history' ? <HistoryPanel api={api} path={note.path} current={content} versions={history} onRestore={(id) => void restoreVersion(id)} /> : null}
            <div className="vault-trust-settings"><strong>安全与信任</strong><label><input type="checkbox" checked={trust.html} onChange={(event) => setTrustValue({ ...trust, html: event.target.checked })} />允许渲染已清理的 HTML</label><small>脚本和事件属性始终被移除；设置仅作用于当前 Vault。</small><label><input type="checkbox" checked={trust.mermaid} onChange={(event) => setTrustValue({ ...trust, mermaid: event.target.checked })} />信任 Mermaid 图表</label><strong>新建链接格式</strong><label className="vault-setting-row"><select aria-label="新建链接格式" value={vaultSettings.newLinkFormat} disabled={settingsBusy || snapshot === null} onChange={(event) => void updateLinkFormat(event.target.value as VaultSettings['newLinkFormat'])}><option value="shortest">最短路径</option><option value="relative">相对路径</option><option value="absolute">Vault 绝对路径</option></select></label>{settingsError !== null ? <small className="vault-setting-error" role="alert">链接格式未保存：{settingsError}</small> : null}</div>
          </aside>
        </div>
        {previewTarget !== null ? <div className="vault-hover-preview" style={{ left: Math.max(16, Math.min(window.innerWidth - 420, previewTarget.anchor.left)), top: Math.min(window.innerHeight - 300, previewTarget.anchor.bottom + 8) }} onMouseEnter={() => { if (previewTimer.current !== null) clearTimeout(previewTimer.current); }} onMouseLeave={schedulePreviewClose} role="dialog" aria-label={`预览 ${previewTarget.title}`}><strong>{previewTarget.title}</strong><NoteReader content={previewTarget.content} path={previewTarget.path} api={api} trustedHtml={trust.html} trustMermaid={trust.mermaid} onOpenLink={trustedLink} onTrustMermaid={() => undefined} /></div> : null}
      </>}
    </main>

    {newNoteOpen ? <div className="vault-modal-backdrop" role="presentation"><form className="vault-modal" onSubmit={(event) => { event.preventDefault(); void createNote(); }}><h2>新建 Markdown 笔记</h2><label>Vault 内路径<input autoFocus value={newNotePath} onChange={(event) => setNewNotePath(event.target.value)} placeholder="Inbox/新笔记.md" /></label><p>正文会直接保存为 Vault 中的 Markdown 文件。</p><div><button type="button" className="button-soft" onClick={() => setNewNoteOpen(false)}>取消</button><button type="submit" className="button-primary">创建</button></div></form></div> : null}
    {newFolderOpen ? <div className="vault-modal-backdrop" role="presentation"><form className="vault-modal" onSubmit={(event) => { event.preventDefault(); void createFolder(); }}><h2>新建文件夹</h2><label>Vault 内路径<input autoFocus value={newFolderPath} onChange={(event) => setNewFolderPath(event.target.value)} placeholder="Inbox/项目" /></label><div><button type="button" className="button-soft" onClick={() => setNewFolderOpen(false)}>取消</button><button type="submit" className="button-primary">创建文件夹</button></div></form></div> : null}
    {treeRenameEntry !== null ? <div className="vault-modal-backdrop" role="presentation"><form className="vault-modal" onSubmit={(event) => { event.preventDefault(); void renameTreeEntry(); }}><h2>重命名或移动</h2><p>{treeRenameEntry.path}</p><label>Vault 内新路径<input autoFocus value={treeRenamePath} onChange={(event) => setTreeRenamePath(event.target.value)} /></label><div><button type="button" className="button-soft" onClick={() => setTreeRenameEntry(null)}>取消</button><button type="submit" className="button-primary">保存路径</button></div></form></div> : null}
    {showDeletedHistory ? <div className="vault-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setShowDeletedHistory(false); }}><div className="vault-modal vault-deleted-paths" role="dialog" aria-modal="true" aria-label="恢复已删除项目"><h2>恢复已删除项目</h2><p>选择路径查看并恢复保留的历史版本。</p>{deletedPaths.map((path) => <button type="button" key={path} onClick={() => { setShowDeletedHistory(false); setRestorePath(path); }}>{path}</button>)}<div><button type="button" className="button-soft" onClick={() => setShowDeletedHistory(false)}>关闭</button></div></div></div> : null}
    {restorePath !== null ? <DeletedHistoryDialog api={api} path={restorePath} onClose={() => setRestorePath(null)} onRestore={(versionId) => void restoreDeletedPath(restorePath, versionId)} /> : null}
    {assetPreview !== null ? <div className="vault-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setAssetPreview(null); }}><div className="vault-asset-modal" role="dialog" aria-modal="true" aria-label={`附件 ${assetPreview.path}`}><header><strong>{assetPreview.path}</strong><button type="button" onClick={() => setAssetPreview(null)} aria-label="关闭附件预览">×</button></header>{assetPreview.mimeType.startsWith('image/') ? <img src={assetPreview.dataUrl} alt={assetPreview.path} /> : assetPreview.mimeType.startsWith('audio/') ? <audio controls src={assetPreview.dataUrl} /> : assetPreview.mimeType.startsWith('video/') ? <video controls src={assetPreview.dataUrl} /> : <a href={assetPreview.dataUrl} download={assetPreview.path.split('/').at(-1)}>下载附件</a>}</div></div> : null}
    {commandOpen ? <div className="vault-modal-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setCommandOpen(false); }}><div className="vault-command-modal" role="dialog" aria-modal="true" aria-label="命令面板"><label><span>⌕</span><input autoFocus value={switcherQuery} onChange={(event) => setSwitcherQuery(event.target.value)} placeholder="输入 > 筛选命令，或搜索笔记…" /></label><div className="vault-command-results">
      {commandRows.map((command) => <button type="button" key={command.id} onClick={() => runCommand(command.id)}><strong><FuzzyText value={command.label} query={commandQuery} /></strong><small>{command.shortcut || (recentCommandIds.includes(command.id) ? '最近使用' : '')}</small></button>)}
      {switcherResults.map((result) => { const titleMatches = fuzzyMatchRanges(switcherQuery, result.title).length > 0; return <button type="button" key={result.path} onClick={() => { setCommandOpen(false); void openNote(result.path); }}><strong><FuzzyText value={titleMatches ? result.title : result.path} query={switcherQuery} /></strong><small>{titleMatches ? result.path : '匹配路径'}</small></button>; })}
    </div></div></div> : null}
  </div>;
}

type PropertyType = 'text' | 'number' | 'boolean' | 'list' | 'yaml';

function PropertyPanel({ vaultRoot, content, onUpdate }: { vaultRoot: string; content: string; metadata: CachedNoteMetadata | null; onUpdate: (key: string, value: unknown) => void }): ReactElement {
  const frontmatter = readFrontmatter(content);
  const [propertyTypes, setPropertyTypes] = useState<Record<string, PropertyType>>({});
  const [yamlDrafts, setYamlDrafts] = useState<Record<string, string>>({});
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(`noltri:vault-property-types:${encodeURIComponent(vaultRoot)}`);
      const parsed: unknown = raw === null ? {} : JSON.parse(raw);
      const valid = ['text', 'number', 'boolean', 'list', 'yaml'];
      setPropertyTypes(parsed !== null && typeof parsed === 'object'
        ? Object.fromEntries(Object.entries(parsed).filter(([, value]) => valid.includes(String(value)))) as Record<string, PropertyType>
        : {});
    } catch { setPropertyTypes({}); }
  }, [vaultRoot]);
  useEffect(() => { setYamlDrafts({}); }, [content]);

  function typeFor(current: unknown): PropertyType {
    if (Array.isArray(current)) return 'list';
    if (typeof current === 'number') return 'number';
    if (typeof current === 'boolean') return 'boolean';
    if (current !== null && typeof current === 'object') return 'yaml';
    return 'text';
  }

  function changeType(name: string, nextType: PropertyType, current: unknown): void {
    const nextTypes = { ...propertyTypes, [name]: nextType };
    setPropertyTypes(nextTypes);
    try { window.localStorage.setItem(`noltri:vault-property-types:${encodeURIComponent(vaultRoot)}`, JSON.stringify(nextTypes)); } catch { /* Typed editing remains available for this session. */ }
    if (nextType === 'text') onUpdate(name, String(current ?? ''));
    else if (nextType === 'number') onUpdate(name, Number.isFinite(Number(current)) ? Number(current) : 0);
    else if (nextType === 'boolean') onUpdate(name, Boolean(current));
    else if (nextType === 'list') onUpdate(name, Array.isArray(current) ? current : String(current ?? '').split(',').map((part) => part.trim()).filter(Boolean));
    else onUpdate(name, current ?? {});
  }

  return <div className="vault-properties">
    {Object.entries(frontmatter).map(([name, current]) => { const selectedType = propertyTypes[name] ?? typeFor(current); const yamlDraft = yamlDrafts[name]; let yamlValid = true; if (yamlDraft !== undefined) { try { YAML.parse(yamlDraft); } catch { yamlValid = false; } } return <label className="vault-property-row" key={name}><span>{name}<small>{selectedType}</small></span>
      <select aria-label={`${name} 属性类型`} value={selectedType} onChange={(event) => changeType(name, event.target.value as PropertyType, current)}><option value="text">文本</option><option value="number">数字</option><option value="boolean">布尔</option><option value="list">列表</option><option value="yaml">YAML</option></select>
      {selectedType === 'boolean' ? <input type="checkbox" checked={Boolean(current)} onChange={(event) => onUpdate(name, event.target.checked)} /> : selectedType === 'number' ? <input type="number" value={typeof current === 'number' ? current : Number(current) || 0} onChange={(event) => onUpdate(name, Number(event.target.value))} /> : selectedType === 'list' ? <input value={Array.isArray(current) ? current.join(', ') : String(current ?? '')} onChange={(event) => onUpdate(name, event.target.value.split(',').map((part) => part.trim()).filter(Boolean))} /> : selectedType === 'yaml' ? <><textarea aria-invalid={!yamlValid} value={yamlDraft ?? YAML.stringify(current)} onChange={(event) => { const raw = event.target.value; setYamlDrafts((drafts) => ({ ...drafts, [name]: raw })); try { onUpdate(name, YAML.parse(raw)); } catch { /* Keep the in-progress YAML text until it parses. */ } }} />{!yamlValid ? <small role="status">YAML 格式尚未完整</small> : null}</> : <input value={String(current ?? '')} onChange={(event) => onUpdate(name, String(event.target.value))} />}
      <button type="button" aria-label={`删除属性 ${name}`} onClick={() => onUpdate(name, undefined)}>×</button>
    </label>; })}
    <form onSubmit={(event) => { event.preventDefault(); if (key.trim()) { onUpdate(key.trim(), value); setKey(''); setValue(''); } }}><input value={key} onChange={(event) => setKey(event.target.value)} placeholder="属性名" aria-label="新属性名称" /><input value={value} onChange={(event) => setValue(event.target.value)} placeholder="值" aria-label="新属性值" /><button type="submit">＋</button></form>
    {Object.keys(frontmatter ?? {}).length === 0 ? <p>添加属性会写入 Markdown YAML frontmatter。</p> : null}
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
