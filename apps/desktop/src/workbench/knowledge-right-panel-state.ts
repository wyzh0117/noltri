export const RIGHT_TOOL_ORDER = ['outline', 'backlinks', 'outgoing', 'tags', 'properties'] as const;
export type RightTool = typeof RIGHT_TOOL_ORDER[number];
export type RightSection = 'relations' | 'interpretation';

export interface RightPanelPreferences {
  section: RightSection;
  tool: RightTool;
  compactGraphHeight: number;
  advancedFilters: { showTags: boolean; showAttachments: boolean; showUnresolved: boolean };
}

export const DEFAULT_RIGHT_PANEL_PREFERENCES: RightPanelPreferences = {
  section: 'relations',
  tool: 'properties',
  compactGraphHeight: 0.54,
  advancedFilters: { showTags: true, showAttachments: false, showUnresolved: false },
};

export function rightPanelPreferencesKey(workspaceKey = 'default'): string {
  return `noltri:knowledge-right-panel-v1:${encodeURIComponent(workspaceKey)}`;
}

function isRightTool(value: unknown): value is RightTool {
  return typeof value === 'string' && (RIGHT_TOOL_ORDER as readonly string[]).includes(value);
}

function isRightSection(value: unknown): value is RightSection {
  return value === 'relations' || value === 'interpretation';
}

export function readRightPanelPreferences(
  storage: Pick<Storage, 'getItem'>,
  key: string,
): RightPanelPreferences {
  try {
    const raw = storage.getItem(key);
    if (raw === null) return DEFAULT_RIGHT_PANEL_PREFERENCES;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return DEFAULT_RIGHT_PANEL_PREFERENCES;
    const value = parsed as { section?: unknown; tool?: unknown; compactGraphHeight?: unknown; advancedFilters?: unknown };
    const height = value.compactGraphHeight;
    const filters = value.advancedFilters !== null && typeof value.advancedFilters === 'object'
      ? value.advancedFilters as { showTags?: unknown; showAttachments?: unknown; showUnresolved?: unknown }
      : {};
    return {
      section: isRightSection(value.section) ? value.section : DEFAULT_RIGHT_PANEL_PREFERENCES.section,
      tool: isRightTool(value.tool) ? value.tool : DEFAULT_RIGHT_PANEL_PREFERENCES.tool,
      compactGraphHeight: typeof height === 'number' && Number.isFinite(height)
        ? Math.min(0.8, Math.max(0.3, height))
        : DEFAULT_RIGHT_PANEL_PREFERENCES.compactGraphHeight,
      advancedFilters: {
        showTags: typeof filters.showTags === 'boolean' ? filters.showTags : DEFAULT_RIGHT_PANEL_PREFERENCES.advancedFilters.showTags,
        showAttachments: typeof filters.showAttachments === 'boolean' ? filters.showAttachments : DEFAULT_RIGHT_PANEL_PREFERENCES.advancedFilters.showAttachments,
        showUnresolved: typeof filters.showUnresolved === 'boolean' ? filters.showUnresolved : DEFAULT_RIGHT_PANEL_PREFERENCES.advancedFilters.showUnresolved,
      },
    };
  } catch {
    return DEFAULT_RIGHT_PANEL_PREFERENCES;
  }
}

export function writeRightPanelPreferences(
  storage: Pick<Storage, 'setItem'>,
  key: string,
  preferences: RightPanelPreferences,
): void {
  try { storage.setItem(key, JSON.stringify(preferences)); }
  catch { /* The panel remains usable when workspace storage is unavailable. */ }
}
