import type { NoteMatchesResponse, VaultGraph, VaultGraphNode } from '@noltri/schema';

export type GraphViewMode = 'global' | 'local';
export type GraphEntityType = VaultGraphNode['type'] | 'tag';

export interface GraphGroupMatch {
  query: string;
  color: string;
  match: GraphQueryMatch;
}

export interface GraphQueryMatch {
  revision: number;
  paths: ReadonlySet<string>;
  matchingTags: ReadonlySet<string>;
  attachmentPaths: ReadonlySet<string>;
  tagIds: ReadonlySet<string>;
}

export function graphQueryMatchFromResponse(response: NoteMatchesResponse): GraphQueryMatch {
  const matchingTags = new Set(response.matchingTags);
  const tagIds = new Set([...matchingTags].map(tagNodeId));
  return {
    revision: response.revision,
    paths: new Set(response.paths),
    matchingTags,
    attachmentPaths: new Set(response.attachmentPaths),
    tagIds,
  };
}

export interface GraphModelOptions {
  mode: GraphViewMode;
  focusPath: string | null;
  depth: number;
  showOutgoing: boolean;
  showIncoming: boolean;
  neighborLinks: boolean;
  showTags: boolean;
  showAttachments: boolean;
  existingFilesOnly: boolean;
  showOrphans: boolean;
  nodeSizeMultiplier: number;
  lineSizeMultiplier: number;
}

export interface GraphModelMatches {
  filter: GraphQueryMatch | null;
  groups: readonly GraphGroupMatch[];
}

export interface GraphViewNode {
  id: string;
  path: string | null;
  title: string;
  basename: string;
  type: GraphEntityType;
  tags: string[];
  degree: number;
  weight: number;
  size: number;
  colorGroup: string | null;
  depth: number | null;
  mtime?: number;
  ctime?: number;
}

export interface GraphViewEdge {
  id: string;
  source: string;
  target: string;
  count: number;
  resolved: boolean;
  width: number;
  mtime?: number;
}

export interface GraphModel {
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
}

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));

export function tagNodeId(tag: string): string {
  return `tag:${tag.trim().replace(/^#/, '').toLocaleLowerCase()}`;
}

export function graphNodeSize(weight: number, multiplier = 1): number {
  return clamp(multiplier, 0.1, 5) * clamp(3 * Math.sqrt(Math.max(0, weight) + 1), 8, 30);
}

function pathTitle(path: string): string {
  const name = path.split('/').at(-1) ?? path;
  return name.replace(/\.[^.]+$/, '');
}

interface MutableNode {
  id: string;
  path: string | null;
  title: string;
  basename: string;
  type: GraphEntityType;
  tags: string[];
  relatedPaths: Set<string>;
  degree: number;
  depth: number | null;
  weight: number;
  colorGroup: string | null;
  mtime?: number;
  ctime?: number;
}

interface MutableEdge {
  id: string;
  source: string;
  target: string;
  count: number;
  resolved: boolean;
  mtime?: number;
}

function matchesNode(node: MutableNode, match: GraphQueryMatch | null): boolean {
  if (match === null || node.type === 'unresolved') return true;
  if (node.type === 'tag') return match.tagIds.has(node.id);
  if (node.path === null) return false;
  return node.type === 'attachment' ? match.attachmentPaths.has(node.path) : match.paths.has(node.path);
}

function colorForGroup(node: MutableNode, groups: readonly GraphGroupMatch[]): string | null {
  for (const group of groups) {
    if (matchesNode(node, group.match)) return group.color;
  }
  return null;
}

export function buildGraphModel(
  data: VaultGraph,
  options: GraphModelOptions,
  matches: GraphModelMatches = { filter: null, groups: [] },
): GraphModel {
  const nodesById = new Map<string, MutableNode>();
  const rawEdges = new Map<string, MutableEdge>();

  const ensureNode = (node: VaultGraphNode): MutableNode => {
    const existing = nodesById.get(node.path);
    if (existing !== undefined) return existing;
    const created: MutableNode = {
      id: node.path,
      path: node.path,
      title: node.title,
      basename: node.basename,
      type: node.type,
      tags: node.tags ?? [],
      mtime: (node as VaultGraphNode & { mtime?: number }).mtime,
      ctime: (node as VaultGraphNode & { ctime?: number }).ctime,
      relatedPaths: new Set([node.path]),
      degree: 0,
      depth: null,
      weight: 0,
      colorGroup: null,
    };
    nodesById.set(created.id, created);
    return created;
  };

  for (const node of data.nodes) ensureNode(node);
  for (const edge of data.edges) {
    if (!nodesById.has(edge.sourcePath)) continue;
    if (!nodesById.has(edge.targetPath)) {
      if (edge.resolved) continue;
      const path = edge.targetPath;
      ensureNode({ path, title: pathTitle(path), basename: pathTitle(path), type: 'unresolved', tags: [] });
    }
    const id = `${edge.sourcePath}\0${edge.targetPath}`;
    const previous = rawEdges.get(id);
    if (previous === undefined) rawEdges.set(id, { id, source: edge.sourcePath, target: edge.targetPath, count: Math.max(1, edge.count), resolved: edge.resolved, mtime: nodesById.get(edge.sourcePath)?.mtime });
    else {
      previous.count += Math.max(1, edge.count);
      previous.resolved = previous.resolved && edge.resolved;
    }
  }

  if (options.showTags) {
    const canonicalTags = new Map<string, MutableNode>();
    for (const note of [...nodesById.values()]) {
      if (note.type !== 'note') continue;
      for (const sourceTag of note.tags) {
        const tag = sourceTag.trim().replace(/^#/, '');
        if (tag === '') continue;
        const id = tagNodeId(tag);
        let tagNode = canonicalTags.get(id);
        if (tagNode === undefined) {
          tagNode = {
            id, path: null, title: `#${tag}`, basename: tag, type: 'tag', tags: [tag], relatedPaths: new Set(),
            degree: 0, depth: null, weight: 0, colorGroup: null,
          };
          canonicalTags.set(id, tagNode);
          nodesById.set(id, tagNode);
        }
      tagNode.relatedPaths.add(note.id);
        const edgeId = `${note.id}\0${tagNode.id}`;
      rawEdges.set(edgeId, { id: edgeId, source: note.id, target: tagNode.id, count: 1, resolved: true, mtime: note.mtime });
      }
    }
  }

  const nodeVisible = (node: MutableNode): boolean => {
    if (node.type === 'tag') return options.showTags && matchesNode(node, matches.filter);
    if (node.type === 'attachment' && !options.showAttachments) return false;
    if (node.type === 'unresolved' && options.existingFilesOnly) return false;
    return matchesNode(node, matches.filter);
  };
  const availableIds = new Set([...nodesById.values()].filter(nodeVisible).map((node) => node.id));
  const allEdges = [...rawEdges.values()].filter((edge) => availableIds.has(edge.source) && availableIds.has(edge.target));
  const incidentEdges = new Map<string, MutableEdge[]>();
  for (const edge of allEdges) {
    for (const id of [edge.source, edge.target]) {
      const incident = incidentEdges.get(id);
      if (incident === undefined) incidentEdges.set(id, [edge]);
      else incident.push(edge);
    }
  }

  let chosenIds = new Set(availableIds);
  let chosenEdges = allEdges;
  const depths = new Map<string, number>();
  if (options.mode === 'local') {
    chosenIds = new Set();
    chosenEdges = [];
    const root = options.focusPath;
    if (root !== null && availableIds.has(root)) {
      chosenIds.add(root);
      depths.set(root, 0);
      let frontier = [root];
      const maxDepth = clamp(Math.floor(options.depth), 1, 5);
      for (let depth = 1; depth <= maxDepth; depth += 1) {
        const next: string[] = [];
        for (const current of frontier) {
          for (const edge of incidentEdges.get(current) ?? []) {
            const isOutgoing = edge.source === current;
            const isIncoming = edge.target === current;
            if ((!isOutgoing || !options.showOutgoing) && (!isIncoming || !options.showIncoming)) continue;
            const other = isOutgoing ? edge.target : edge.source;
            if (!availableIds.has(other)) continue;
            chosenEdges.push(edge);
            if (!chosenIds.has(other)) {
              chosenIds.add(other);
              depths.set(other, depth);
              if (nodesById.get(other)?.type !== 'tag' && nodesById.get(other)?.type !== 'unresolved') next.push(other);
            }
          }
        }
        frontier = next;
        if (frontier.length === 0) break;
      }
      if (options.neighborLinks) chosenEdges = allEdges.filter((edge) => chosenIds.has(edge.source) && chosenIds.has(edge.target));
      else chosenEdges = [...new Map(chosenEdges.map((edge) => [edge.id, edge])).values()];
    }
  }

  const degrees = new Map([...chosenIds].map((id) => [id, 0]));
  for (const edge of chosenEdges) {
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + edge.count);
    degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + edge.count);
  }
  if (!options.showOrphans) {
    for (const id of chosenIds) {
      if ((degrees.get(id) ?? 0) === 0 && !(options.mode === 'local' && id === options.focusPath)) chosenIds.delete(id);
    }
    chosenEdges = chosenEdges.filter((edge) => chosenIds.has(edge.source) && chosenIds.has(edge.target));
  }

  const nodes = [...chosenIds].map((id) => {
    const node = nodesById.get(id)!;
    const degree = degrees.get(id) ?? 0;
    const depth = depths.get(id) ?? null;
    const localWeight = depth === null ? degree : Math.max(0, 30 - (30 / Math.max(1, options.depth)) * depth);
    node.degree = degree;
    node.depth = depth;
    node.weight = depth === null ? degree : localWeight;
    node.colorGroup = colorForGroup(node, matches.groups);
    return {
      id: node.id,
      path: node.path,
      title: node.title,
      basename: node.basename,
      type: node.type,
      tags: [...node.tags],
      degree,
      weight: node.weight,
      size: graphNodeSize(node.weight, options.nodeSizeMultiplier),
      colorGroup: node.colorGroup,
      depth,
      mtime: node.mtime,
      ctime: node.ctime,
    } satisfies GraphViewNode;
  });
  const edges = chosenEdges
    .filter((edge) => chosenIds.has(edge.source) && chosenIds.has(edge.target))
    .map((edge) => ({
      ...edge,
      width: clamp(options.lineSizeMultiplier, 0.1, 5),
      mtime: edge.mtime,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  return { nodes: nodes.sort((left, right) => left.id.localeCompare(right.id)), edges };
}
