export interface Span { from: number; to: number }
export interface MarkdownNode {
  type: string; value?: string; depth?: number; url?: string; identifier?: string;
  checked?: boolean | null; children?: MarkdownNode[];
  position?: { start: { offset?: number; line: number; column: number }; end: { offset?: number; line: number; column: number } };
}
export interface Heading extends Span { depth: number; text: string; path: string[]; contentFrom: number; contentTo: number }
export interface MarkdownLink extends Span {
  kind: 'wiki' | 'markdown' | 'property' | 'reference'; raw: string; target: string;
  targetFrom: number; targetTo: number; embed: boolean; label?: string;
  propertyPath?: (string | number)[];
}
export interface MarkdownBlock extends Span { id?: string; alias?: string; type: string; text: string }
export interface ParsedMarkdown {
  ast: MarkdownNode; headings: Heading[]; sections: Heading[]; links: MarkdownLink[];
  tags: (Span & { tag: string; property: boolean })[];
  blocks: MarkdownBlock[]; tasks: (Span & { checked: boolean; text: string })[];
  footnotes: (Span & { id: string; definition: boolean })[];
  properties: Record<string, unknown>; aliases: string[]; excluded: Span[];
  frontmatter?: Span & { valueFrom: number; valueTo: number };
}
export interface EngineLocation { kind: 'course' | 'chapter' | 'entry'; courseId: string; courseChapterId?: string | null; entryId?: string; blockId?: string; headingPath?: string[] }
export interface LinkTarget {
  courseId: string; title: string; path: string; aliases?: string[]; headings?: (Heading & { courseChapterId?: string | null; entryId?: string })[];
  blocks?: (MarkdownBlock & { entryId?: string; courseChapterId?: string | null })[];
}
export interface LinkContext {
  courseId: string; courseChapterId?: string | null; entryId?: string; sourcePath?: string;
  importPaths?: Record<string, EngineLocation[]>; stableTarget?: EngineLocation;
}
export type LinkResolution =
  | { status: 'resolved'; target: EngineLocation }
  | { status: 'ambiguous'; candidates: EngineLocation[] }
  | { status: 'unresolved'; raw: string }
  | { status: 'subpath-missing'; target: EngineLocation; subpath: string };
