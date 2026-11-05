import { describe, expect, it } from 'vitest';
import { DEFAULT_GRAPH_SETTINGS, defaultGraphGroupColor, graphColorInputValue, normalizeGraphSettings } from './workbench-graph-settings';

describe('graph view settings', () => {
  it('uses the documented force defaults and group colors', () => {
    expect(DEFAULT_GRAPH_SETTINGS.forces).toEqual({ centerStrength: 0.1, repelStrength: 10, linkStrength: 1, linkDistance: 250 });
    expect(defaultGraphGroupColor(2)).toBe('hsl(80 60% 60%)');
    expect(defaultGraphGroupColor(1, true)).toBe('hsl(40 70% 60%)');
    expect(graphColorInputValue('hsl(80 60% 60%)')).toMatch(/^#[\da-f]{6}$/i);
  });

  it('sanitizes persisted settings and ignores malformed groups', () => {
    const normalized = normalizeGraphSettings({
      filterQuery: 'x'.repeat(3000), labelMode: 'unknown', nodeSizeMultiplier: -3,
      groups: [{ query: 'tag:x', color: 'url(https://bad)', id: 'x' }, null, { id: 'ok', query: 'path:docs', color: '#aabbcc' }],
      forces: { centerStrength: Number.NaN, repelStrength: 50, linkDistance: 12 },
    });
    expect(normalized.filterQuery).toHaveLength(2000);
    expect(normalized.labelMode).toBe('auto');
    expect(normalized.nodeSizeMultiplier).toBe(0.1);
    expect(normalized.groups).toEqual([
      { id: 'x', query: 'tag:x', color: defaultGraphGroupColor(0) },
      { id: 'ok', query: 'path:docs', color: '#aabbcc' },
    ]);
    expect(normalized.forces).toEqual({ centerStrength: 0, repelStrength: 20, linkStrength: 1, linkDistance: 30 });
  });
});
