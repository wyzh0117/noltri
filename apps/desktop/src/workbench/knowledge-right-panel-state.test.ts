import { describe, expect, it } from 'vitest';
import { DEFAULT_RIGHT_PANEL_PREFERENCES, RIGHT_TOOL_ORDER, readRightPanelPreferences, rightPanelPreferencesKey, writeRightPanelPreferences } from './knowledge-right-panel-state';

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    values,
  };
}

describe('right panel preferences', () => {
  it('keeps the approved tool order and defaults to the final properties view', () => {
    expect(RIGHT_TOOL_ORDER).toEqual(['outline', 'backlinks', 'outgoing', 'tags', 'properties']);
    expect(readRightPanelPreferences(storage(), rightPanelPreferencesKey('test'))).toEqual(DEFAULT_RIGHT_PANEL_PREFERENCES);
  });

  it('restores a valid tool and section, while ignoring stale tool names', () => {
    const key = rightPanelPreferencesKey('test');
    const state = storage({ [key]: JSON.stringify({ section: 'interpretation', tool: 'outline' }) });
    expect(readRightPanelPreferences(state, key)).toEqual({ ...DEFAULT_RIGHT_PANEL_PREFERENCES, section: 'interpretation', tool: 'outline' });
    state.setItem(key, JSON.stringify({ section: 'relations', tool: 'mentions' }));
    expect(readRightPanelPreferences(state, key)).toEqual(DEFAULT_RIGHT_PANEL_PREFERENCES);
  });

  it('persists the selected panel without failing when storage is unavailable', () => {
    const key = rightPanelPreferencesKey('workspace/a');
    const state = storage();
    writeRightPanelPreferences(state, key, { ...DEFAULT_RIGHT_PANEL_PREFERENCES, tool: 'backlinks' });
    expect(readRightPanelPreferences(state, key)).toEqual({ ...DEFAULT_RIGHT_PANEL_PREFERENCES, tool: 'backlinks' });
    expect(rightPanelPreferencesKey('workspace/a')).not.toBe(rightPanelPreferencesKey('workspace/b'));
    expect(() => writeRightPanelPreferences({ setItem: () => { throw new Error('quota'); } }, key, DEFAULT_RIGHT_PANEL_PREFERENCES)).not.toThrow();
  });
});
