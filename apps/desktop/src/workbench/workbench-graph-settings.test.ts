import { describe, expect, it } from 'vitest';
import { DEFAULT_GRAPH_SETTINGS, defaultGraphGroupColor, normalizeGraphSettings } from './workbench-graph-settings';

describe('graph view settings', () => {
  it('uses the documented display and force defaults', () => {
    expect(DEFAULT_GRAPH_SETTINGS).toMatchObject({
      showTags: false, showAttachments: false, existingFilesOnly: false, showOrphans: true,
      showOutgoing: true, showIncoming: true, neighborLinks: false, depth: 1,
      forces: { centerStrength: 0.1, repelStrength: 10, linkStrength: 1, linkDistance: 250 },
    });
    expect(defaultGraphGroupColor(2)).toBe('hsl(80 60% 60%)');
    expect(defaultGraphGroupColor(1, true)).toBe('hsl(40 70% 60%)');
  });

  it('sanitizes persisted settings and ignores malformed groups', () => {
    const normalized = normalizeGraphSettings({
      depth: 99, labelMode: 'unknown', showTags: true, nodeSizeMultiplier: -3,
      groups: [{ query: 'tag:x', color: 'url(https://bad)', id: 'x' }, null, { id: 'ok', query: 'path:docs', color: '#aabbcc' }],
      forces: { centerStrength: Number.NaN, repelStrength: 50, linkDistance: 12 },
    });
    expect(normalized.depth).toBe(5);
    expect(normalized.labelMode).toBe('auto');
    expect(normalized.nodeSizeMultiplier).toBe(0.1);
    expect(normalized.groups).toEqual([
      { id: 'x', query: 'tag:x', color: defaultGraphGroupColor(0) },
      { id: 'ok', query: 'path:docs', color: '#aabbcc' },
    ]);
    expect(normalized.forces).toEqual({ centerStrength: 0, repelStrength: 20, linkStrength: 1, linkDistance: 30 });
  });
});
