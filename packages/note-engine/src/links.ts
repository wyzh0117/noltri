import { isScalar, parseDocument } from 'yaml';
import { normalizeHeading, normalizeIdentity, parseMarkdown } from './metadata';
import type { EngineLocation, LinkContext, LinkResolution, LinkTarget, MarkdownLink, Span } from './types';

function bareLink(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('![[')) text = text.slice(1);
  if (text.startsWith('[[') && text.endsWith(']]')) return text.slice(2, -2).split('|')[0];
  return text;
}
export function isKnowledgeReference(raw: string): boolean {
  const text = bareLink(raw);
  return !/^(?:[a-z][a-z\d+.-]*:|\/\/)/iu.test(text) && !text.includes('\0');
}
function virtualPath(raw: string, base = ''): string | null {
  if (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/iu.test(raw) || raw.includes('\0')) return null;
  const parts = base.split('/').filter(Boolean); parts.pop();
  for (const part of raw.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); } else parts.push(part);
  }
  return parts.join('/');
}
const courseLocation = (target: LinkTarget): EngineLocation => ({ kind: 'course', courseId: target.courseId });
const distinct = (values: EngineLocation[]): EngineLocation[] => [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];

/** Identity first, unambiguous normalized names second. No caller can accidentally pick row zero. */
export function resolveKnowledgeLink(context: LinkContext, rawLink: string, targets: readonly LinkTarget[]): LinkResolution {
  const raw = bareLink(rawLink);
  if (!isKnowledgeReference(raw)) return { status: 'unresolved', raw: rawLink };
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { return { status: 'unresolved', raw: rawLink }; }
  const hash = decoded.indexOf('#');
  const name = (hash < 0 ? decoded : decoded.slice(0, hash)).trim();
  const subpath = hash < 0 ? '' : decoded.slice(hash + 1);
  let candidates: LinkTarget[] = [];
  let mapped: EngineLocation[] | undefined;
  if (context.stableTarget) candidates = targets.filter((target) => target.courseId === context.stableTarget!.courseId);
  else if (!name) candidates = targets.filter((target) => target.courseId === context.courseId);
  else {
    const key = normalizeIdentity(name.replace(/\.md$/iu, ''));
    const mappedPath = virtualPath(name, context.sourcePath);
    if (mappedPath !== null && context.importPaths) {
      const paths = Object.entries(context.importPaths).filter(([path]) => normalizeIdentity(path.replace(/\.md$/iu, '')) === normalizeIdentity(mappedPath.replace(/\.md$/iu, '')));
      mapped = distinct(paths.flatMap(([, locations]) => locations));
      if (mapped.length) candidates = targets.filter((target) => mapped!.some((location) => location.courseId === target.courseId));
    }
    if (!candidates.length) candidates = targets.filter((target) => target.courseId === name || normalizeIdentity(target.path.replace(/\.md$/iu, '')) === key);
    if (!candidates.length && !name.includes('/') && !name.includes('\\')) candidates = targets.filter((target) => [target.title, ...(target.aliases ?? [])].some((title) => normalizeIdentity(title) === key));
    if (!candidates.length && name.includes('/') && mappedPath !== null) candidates = targets.filter((target) => normalizeIdentity(target.path).endsWith(`/${key}`));
  }
  if (!candidates.length) return { status: 'unresolved', raw: rawLink };
  if (candidates.length > 1 || (mapped && mapped.length > 1)) return { status: 'ambiguous', candidates: mapped?.length ? mapped : candidates.map(courseLocation) };
  const course = candidates[0];
  const base = courseLocation(course);
  if (!subpath) return { status: 'resolved', target: context.stableTarget ?? mapped?.[0] ?? base };
  if (context.stableTarget?.blockId) {
    const block = course.blocks?.find((block) => block.id === context.stableTarget!.blockId && (!context.stableTarget!.entryId || block.entryId === context.stableTarget!.entryId));
    if (block) return { status: 'resolved', target: { ...context.stableTarget, courseChapterId: block.courseChapterId ?? null, ...(block.entryId ? { entryId: block.entryId } : {}) } };
    return { status: 'subpath-missing', target: base, subpath };
  }
  // An existing resolved identity survives heading/title changes; absence still invalidates it.
  if (context.stableTarget?.entryId && !context.stableTarget.blockId && course.headings?.some((heading) => heading.entryId === context.stableTarget!.entryId)) return { status: 'resolved', target: context.stableTarget };
  if (subpath.startsWith('^')) {
    const key = normalizeIdentity(subpath.slice(1));
    const blocks = (course.blocks ?? []).filter((block) => [block.id, block.alias].some((id) => id && normalizeIdentity(id) === key));
    const matches = distinct(blocks.map((block) => ({ kind: 'entry', courseId: course.courseId, courseChapterId: block.courseChapterId ?? null, ...(block.entryId ? { entryId: block.entryId } : {}), blockId: block.id ?? block.alias! })));
    if (matches.length === 1) return { status: 'resolved', target: matches[0] };
    if (matches.length > 1) return { status: 'ambiguous', candidates: matches };
    return { status: 'subpath-missing', target: base, subpath };
  }
  const requested = subpath.split('#').filter(Boolean).map(normalizeHeading);
  const headings = (course.headings ?? []).filter((heading) => {
    const actual = heading.path.map(normalizeHeading);
    if (!requested.length || requested.at(-1) !== actual.at(-1)) return false;
    let index = 0;
    for (const part of actual) if (part === requested[index]) index++;
    return index === requested.length;
  });
  const matches = distinct(headings.map((heading) => heading.entryId
    ? { kind: 'entry', courseId: course.courseId, courseChapterId: heading.courseChapterId ?? null, entryId: heading.entryId, headingPath: heading.path }
    : heading.courseChapterId ? { kind: 'chapter', courseId: course.courseId, courseChapterId: heading.courseChapterId } : base));
  if (matches.length === 1) return { status: 'resolved', target: matches[0] };
  if (matches.length > 1) return { status: 'ambiguous', candidates: matches };
  return { status: 'subpath-missing', target: base, subpath };
}

export interface ReferenceRewrite { reference: MarkdownLink; target: string; oldDefaultLabel?: string; newDefaultLabel?: string }
export function applyTextChanges(text: string, changes: (Span & { insert: string })[]): string {
  const ordered = [...changes].sort((a, b) => a.from - b.from || a.to - b.to);
  let end = 0;
  for (const change of ordered) {
    if (!Number.isInteger(change.from) || !Number.isInteger(change.to) || change.from < end || change.to < change.from || change.to > text.length) throw new Error('Overlapping or invalid UTF-16 ranges');
    end = change.to;
  }
  for (const change of ordered.reverse()) text = text.slice(0, change.from) + change.insert + text.slice(change.to);
  return text;
}

/** AST coordinates for body references, YAML path+scalar editing for properties. */
export function rewriteReferences(text: string, edits: readonly ReferenceRewrite[]): string {
  const metadata = parseMarkdown(text);
  const body: (Span & { insert: string })[] = [];
  const properties = edits.filter((edit) => edit.reference.kind === 'property');
  const add = (change: Span & { insert: string }) => { if (!body.some((existing) => existing.from === change.from && existing.to === change.to && existing.insert === change.insert)) body.push(change); };
  for (const edit of edits.filter((edit) => edit.reference.kind !== 'property')) {
    const { reference } = edit;
    if (text.slice(reference.from, reference.to) !== reference.raw) throw new Error('Reference revision changed');
    add({ from: reference.targetFrom, to: reference.targetTo, insert: edit.target });
    if (reference.kind === 'wiki' && edit.oldDefaultLabel !== undefined && reference.label === edit.oldDefaultLabel) add({ from: reference.targetTo + 1, to: reference.to - 2, insert: edit.newDefaultLabel ?? edit.target.split('#')[0] });
  }
  if (properties.length) {
    if (!metadata.frontmatter) throw new Error('Property reference has no frontmatter');
    const { valueFrom, valueTo } = metadata.frontmatter;
    const doc = parseDocument(text.slice(valueFrom, valueTo), { keepSourceTokens: true });
    const byPath = new Map<string, ReferenceRewrite[]>();
    for (const edit of properties) { const key = JSON.stringify(edit.reference.propertyPath); const values = byPath.get(key) ?? []; values.push(edit); byPath.set(key, values); }
    for (const values of byPath.values()) {
      const path = values[0].reference.propertyPath;
      if (!path) throw new Error('Property reference has no YAML key');
      const node = doc.getIn(path, true);
      if (!isScalar(node) || typeof node.value !== 'string') throw new Error('YAML reference is no longer a string');
      const scalarText = node.value;
      const local = [...scalarText.matchAll(/(!?)\[\[([^\]\n]*)\]\]/g)];
      const original = metadata.links.filter((link) => link.kind === 'property' && JSON.stringify(link.propertyPath) === JSON.stringify(path));
      const changes = values.flatMap((edit) => {
        const index = original.findIndex((link) => link.from === edit.reference.from && link.to === edit.reference.to);
        const match = local[index]; if (!match) throw new Error('YAML reference revision changed');
        const from = match.index + match[1].length + 2;
        const pipe = match[2].indexOf('|'); const to = from + (pipe < 0 ? match[2].length : pipe);
        const changes = [{ from, to, insert: edit.target }];
        if (pipe >= 0 && edit.oldDefaultLabel !== undefined && edit.reference.label === edit.oldDefaultLabel) changes.push({ from: to + 1, to: match.index + match[0].length - 2, insert: edit.newDefaultLabel ?? edit.target.split('#')[0] });
        return changes;
      });
      node.value = applyTextChanges(scalarText, changes);
    }
    add({ from: valueFrom, to: valueTo, insert: doc.toString() });
  }
  return applyTextChanges(text, body);
}

export function formatLinkTarget(location: EngineLocation, targets: readonly LinkTarget[]): string {
  const course = targets.find((target) => target.courseId === location.courseId);
  if (!course) throw new Error('Cannot format unknown course identity');
  if (location.blockId) {
    const block = course.blocks?.find((candidate) => candidate.id === location.blockId || candidate.alias === location.blockId);
    return `${location.courseId}#^${block?.alias ?? location.blockId}`;
  }
  if (location.courseChapterId || location.entryId) {
    const heading = course.headings?.find((candidate) => (location.entryId ? candidate.entryId === location.entryId : candidate.courseChapterId === location.courseChapterId) && (!location.headingPath || location.headingPath.at(-1) === candidate.path.at(-1)));
    if (heading) return `${location.courseId}#${heading.path.join('#')}`;
  }
  return location.courseId;
}
