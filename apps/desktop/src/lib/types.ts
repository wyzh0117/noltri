/**
 * Shapes mirrored from the Rust command outputs (`serde(rename_all = "camelCase")`). Kept as plain
 * interfaces on purpose: the compile-time link to Rust is the field names, which the Setup Manager
 * renders directly.
 */

export type ObserverStatus =
  | 'idle'
  | 'running'
  | 'needs_permission'
  | { read_failed: string }
  | 'disabled';

export interface Sample {
  readonly id: string;
  readonly preview: string;
  readonly length: number;
  readonly text: string;
  readonly app_name: string;
  readonly bundle_id: string | null;
  readonly window_title: string | null;
  readonly rect: { x: number; y: number; width: number; height: number } | null;
  readonly estimated: boolean;
  readonly captured_at: string;
}

export interface CaptureOutcome {
  readonly ok: boolean;
  readonly length: number;
  readonly app_name: string;
  readonly path: string[];
  readonly message: string;
  readonly via: string;
  readonly at: string;
}

export interface IncompatibleApp {
  readonly app: string;
  readonly bundle_id?: string;
  readonly reason: string;
  readonly attempts: number;
  readonly last_seen: string;
}

export type OverlayPositionMode = 'selection' | 'caret' | 'center';

export interface SettingsShape {
  readonly apiBaseUrl: string;
  readonly apiToken: string;
  readonly mcpEndpoint: string;
  readonly minSelectionLength: number;
  readonly overlayPositionMode: OverlayPositionMode;
  readonly captureEnabled: boolean;
  readonly autoShowOverlay: boolean;
  readonly globalShortcut: string;
  readonly disabledApps: string[];
  readonly incompatibleApps: IncompatibleApp[];
  readonly deviceId: string;
}

export interface CaptureStateOut {
  readonly accessibilityTrusted: boolean;
  readonly captureEnabled: boolean;
  readonly autoShowOverlay: boolean;
  readonly observerRunning: boolean;
  readonly status: ObserverStatus;
  readonly desktopCaptureOk: boolean;
  readonly lastTickAt: string | null;
  readonly lastSample: Sample | null;
  readonly minSelectionLength: number;
  readonly overlayPositionMode: OverlayPositionMode;
  readonly disabledApps: string[];
  readonly incompatibleApps: IncompatibleApp[];
  readonly recent: CaptureOutcome[];
  readonly ownWindowFocused: boolean;
  readonly apiBaseUrl: string;
  readonly mcpEndpoint: string;
  readonly globalShortcut: string;
  readonly deviceId: string;
  readonly settingsWarning: string | null;
}

export interface SelectionProbeOut {
  readonly ok: boolean;
  readonly reason: string;
  readonly length: number;
  readonly preview: string;
  readonly appName: string;
  readonly bundleId: string | null;
  readonly estimated: boolean;
  readonly capturedAt: string;
}

export interface ConnectionProbeOut {
  readonly target: string;
  readonly coreBaseUrl: string;
  readonly mcpEndpoint: string;
  readonly tokenConfigured: boolean;
  readonly configPath: string | null;
  readonly configEntryPresent: boolean;
  readonly configEntryDetail: string | null;
  readonly writeSupported: boolean;
  readonly supportState: string;
  readonly installedApps: string[];
  readonly appPath: string | null;
  readonly appVersion: string | null;
  readonly networkFrom: string;
}

export interface TargetFacts {
  readonly target: string;
  readonly label: string;
  readonly serverName: string;
  readonly configPath: string | null;
  readonly configPathExists: boolean;
  readonly writeSupported: boolean;
  /** `writable` | `guided` | `unverified`, straight from the registry. Never derived in the UI. */
  readonly supportState: string;
  readonly officialSettingsUrl: string | null;
  readonly docsUrl: string | null;
  readonly guidance: string;
  readonly installedApps: string[];
  readonly appPath: string | null;
  /** The version the bundle's own Info.plist reports; null means 「版本未知」, not 「未安装」. */
  readonly appVersion: string | null;
  readonly endpoint: string;
  readonly coreBaseUrl: string;
  readonly tokenConfigured: boolean;
}

/** One 修改前备份 Setup Manager made for a config file, newest first (`list_config_backups`). */
export interface ConfigBackup {
  readonly file: string;
  /** Epoch milliseconds from the file name — the only stamp that survives a rename. */
  readonly madeAt: number;
  readonly bytes: number;
  /** The same instant rendered for a human, UTC. */
  readonly madeAtLabel: string;
}

/** `browser_host_status` — the installed app's registration entry for the browser channel (M05). */
export interface BrowserHostStatus {
  /** False in dev builds: registration is only offered where a bundle exists. */
  readonly serviceable: boolean;
  readonly note: string;
  readonly launcherPath: string;
  readonly launcherPresent: boolean;
  readonly manifestFile: string | null;
  readonly currentExecutable: string | null;
  /** True when the recorded path is exactly our launcher — nothing to repair. */
  readonly managed: boolean | null;
}
