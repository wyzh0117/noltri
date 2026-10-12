import { MIN_CAPTURE_TEXT_LENGTH, previewImageUrlSchema, type CaptureRequest } from '@noltri/schema';
import { normalizeKnowledgeText } from '@noltri/shared';
import { buildExtensionCaptureRequest, type CaptureIntent, type CaptureRequestMeta } from './build-request';
import { buildSource, parseHttpHref, type PageCollectionContext } from '../source/extract';

export type { CaptureIntent, CaptureRequestMeta };

export interface MenuSelectionInput {
  readonly selectionText: string;
  readonly pageHref: string;
  readonly pageTitle: string;
  readonly surroundingContext?: string;
}

export interface MenuPageInput extends PageCollectionContext {
  readonly pageHref: string;
}

export interface MenuImageInput {
  readonly pageHref: string;
  readonly pageTitle: string;
  readonly imageHref: string;
  readonly imageAltText?: string;
}

/** Entry 1 — the floating pill: the content script already measured the page. */
export function requestFromPillSelection(intent: CaptureIntent, meta: CaptureRequestMeta): CaptureRequest {
  return buildExtensionCaptureRequest(intent, meta);
}

/**
 * Entry 2 — the context menu: Chrome only hands over `selectionText` plus tab metadata, so the intent
 * is rebuilt here with the same source builder. Both entries converge on `buildExtensionCaptureRequest`,
 * which is what makes the two paths send byte-identical payloads.
 */
export function requestFromMenuSelection(input: MenuSelectionInput, meta: CaptureRequestMeta): CaptureRequest {
  return buildExtensionCaptureRequest(intentFromMenuSelection(input), meta);
}

/** Entry 3 — collect only the page's declared title/description and Open Graph image. */
export function requestFromMenuPage(input: MenuPageInput, meta: CaptureRequestMeta): CaptureRequest | undefined {
  const pageUrl = parseHttpHref(input.pageHref);
  if (!pageUrl) return undefined;
  const title = input.title.trim() || pageUrl.hostname;
  const candidate = normalizeKnowledgeText(input.description || title);
  const text = candidate.length >= MIN_CAPTURE_TEXT_LENGTH
    ? candidate
    : normalizeKnowledgeText(`${candidate} — ${pageUrl.hostname}`);
  if (text.length < MIN_CAPTURE_TEXT_LENGTH) return undefined;
  const preview = previewImageUrlSchema.safeParse(input.previewImageUrl);
  const intent: CaptureIntent = {
    text,
    source: buildSource({ href: pageUrl.href, title }),
    library: {
      kind: 'web_page',
      ...(preview.success ? { previewImageUrl: preview.data } : {}),
    },
  };
  return buildExtensionCaptureRequest(intent, meta);
}

/** Entry 4 — collect the selected image file and its alt text, never the surrounding page. */
export function requestFromMenuImage(input: MenuImageInput, meta: CaptureRequestMeta): CaptureRequest | undefined {
  const pageUrl = parseHttpHref(input.pageHref);
  const imageUrl = parseHttpHref(input.imageHref);
  if (!pageUrl || !imageUrl) return undefined;
  const pageTitle = input.pageTitle.trim() || pageUrl.hostname;
  const imageDescription = input.imageAltText?.trim() || pageTitle;
  const text = normalizeKnowledgeText(`图片：${imageDescription}（来自 ${pageUrl.hostname}）`);
  if (text.length < MIN_CAPTURE_TEXT_LENGTH) return undefined;
  const preview = previewImageUrlSchema.safeParse(imageUrl.href);
  const intent: CaptureIntent = {
    text,
    source: buildSource({ href: pageUrl.href, title: pageTitle }),
    library: {
      kind: 'image',
      ...(preview.success ? { previewImageUrl: preview.data } : {}),
    },
  };
  return buildExtensionCaptureRequest(intent, meta);
}

export function intentFromMenuSelection(input: MenuSelectionInput): CaptureIntent {
  return {
    text: input.selectionText,
    source: buildSource({ href: input.pageHref, title: input.pageTitle }),
    ...(input.surroundingContext ? { surroundingContext: input.surroundingContext } : {}),
  };
}
