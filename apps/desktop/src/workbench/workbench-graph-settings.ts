import { DEFAULT_GRAPH_FORCES, normalizeGraphForces } from './workbench-graph-simulation';
import type { GraphForces } from './workbench-graph-simulation';

export interface GraphColorGroup {
  id: string;
  query: string;
  color: string;
}

export interface GraphSettings {
  filterQuery: string;
  groups: GraphColorGroup[];
  showTags: boolean;
  showAttachments: boolean;
  existingFilesOnly: boolean;
  showOrphans: boolean;
  showArrows: boolean;
  showOutgoing: boolean;
  showIncoming: boolean;
  neighborLinks: boolean;
  depth: number;
  labelMode: 'auto' | 'show' | 'hide';
  nodeSizeMultiplier: number;
  lineSizeMultiplier: number;
  timelineProgress: number;
  forces: GraphForces;
}

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  filterQuery: '',
  groups: [],
  showTags: false,
  showAttachments: false,
  existingFilesOnly: false,
  showOrphans: true,
  showArrows: false,
  showOutgoing: true,
  showIncoming: true,
  neighborLinks: false,
  depth: 1,
  labelMode: 'auto',
  nodeSizeMultiplier: 1,
  lineSizeMultiplier: 1,
  timelineProgress: 1,
  forces: DEFAULT_GRAPH_FORCES,
};

const clamp = (value: number, minimum: number, maximum: number, fallback: number): number =>
  Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : fallback));

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedGroup(value: unknown, index: number): GraphColorGroup | null {
  if (!isRecord(value)) return null;
  const query = typeof value.query === 'string' ? value.query.slice(0, 2000) : '';
  const color = typeof value.color === 'string' && (/^#[\da-f]{6}$/i.test(value.color) || /^hsl\(\d{1,3}(?:\.\d+)?\s+\d{1,3}%\s+\d{1,3}%\)$/i.test(value.color))
    ? value.color : defaultGraphGroupColor(index);
  const id = typeof value.id === 'string' && value.id !== '' ? value.id.slice(0, 120) : `group-${index + 1}`;
  return { id, query, color };
}

export function defaultGraphGroupColor(index: number, dark = false): string {
  return `hsl(${(40 * index) % 360} ${dark ? 70 : 60}% 60%)`;
}

export function graphColorInputValue(color: string): string {
  const hex = color.match(/^#([\da-f]{6})$/i)?.[1];
  if (hex !== undefined) return `#${hex}`;
  const match = color.match(/^hsl\((\d{1,3}(?:\.\d+)?)\s+(\d{1,3})%\s+(\d{1,3})%\)$/i);
  if (match === null) return '#3d6853';
  const hue = Number(match[1]) / 360;
  const saturation = Number(match[2]) / 100;
  const lightness = Number(match[3]) / 100;
  const channel = (offset: number): number => {
    const k = (offset + hue * 12) % 12;
    const a = saturation * Math.min(lightness, 1 - lightness);
    return Math.round(255 * (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return `#${[channel(0), channel(8), channel(4)].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export function normalizeGraphSettings(value: unknown): GraphSettings {
  if (!isRecord(value)) return { ...DEFAULT_GRAPH_SETTINGS, groups: [] };
  const groups = Array.isArray(value.groups)
    ? value.groups.map(normalizedGroup).filter((group): group is GraphColorGroup => group !== null).slice(0, 32)
    : [];
  const labelMode = value.labelMode === 'show' || value.labelMode === 'hide' ? value.labelMode : 'auto';
  return {
    filterQuery: typeof value.filterQuery === 'string' ? value.filterQuery.slice(0, 2000) : '',
    groups,
    showTags: typeof value.showTags === 'boolean' ? value.showTags : DEFAULT_GRAPH_SETTINGS.showTags,
    showAttachments: typeof value.showAttachments === 'boolean' ? value.showAttachments : DEFAULT_GRAPH_SETTINGS.showAttachments,
    existingFilesOnly: typeof value.existingFilesOnly === 'boolean' ? value.existingFilesOnly : DEFAULT_GRAPH_SETTINGS.existingFilesOnly,
    showOrphans: typeof value.showOrphans === 'boolean' ? value.showOrphans : DEFAULT_GRAPH_SETTINGS.showOrphans,
    showArrows: typeof value.showArrows === 'boolean' ? value.showArrows : DEFAULT_GRAPH_SETTINGS.showArrows,
    showOutgoing: typeof value.showOutgoing === 'boolean' ? value.showOutgoing : DEFAULT_GRAPH_SETTINGS.showOutgoing,
    showIncoming: typeof value.showIncoming === 'boolean' ? value.showIncoming : DEFAULT_GRAPH_SETTINGS.showIncoming,
    neighborLinks: typeof value.neighborLinks === 'boolean' ? value.neighborLinks : DEFAULT_GRAPH_SETTINGS.neighborLinks,
    depth: Math.round(clamp(Number(value.depth), 1, 5, DEFAULT_GRAPH_SETTINGS.depth)),
    labelMode,
    nodeSizeMultiplier: clamp(Number(value.nodeSizeMultiplier), 0.1, 5, DEFAULT_GRAPH_SETTINGS.nodeSizeMultiplier),
    lineSizeMultiplier: clamp(Number(value.lineSizeMultiplier), 0.1, 5, DEFAULT_GRAPH_SETTINGS.lineSizeMultiplier),
    timelineProgress: clamp(Number(value.timelineProgress), 0, 1, DEFAULT_GRAPH_SETTINGS.timelineProgress),
    forces: normalizeGraphForces(isRecord(value.forces) ? value.forces as Partial<GraphForces> : DEFAULT_GRAPH_SETTINGS.forces),
  };
}

export function createGraphGroup(index: number): GraphColorGroup {
  return { id: `group-${Date.now()}-${index}`, query: '', color: defaultGraphGroupColor(index) };
}
