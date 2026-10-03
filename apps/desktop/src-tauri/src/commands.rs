//! Tauri commands: the whole IPC surface the Setup Manager, the pill and the paste window use.
//!
//! Window mutations live here rather than in the frontend so the capability surface stays
//! `core:default` + global-shortcut: the webviews only `listen()` and call these commands.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::accessibility::ax::{self, Rect};
use crate::accessibility::observer::{self, Probe, CAPTURE_RESULT_EVENT, SELECTION_CHANGED_EVENT};
use crate::mcp::{self, Target, TargetFacts};
use crate::overlay;
use crate::settings::{self, IncompatibleApp, OverlayPositionMode, Settings, SettingsPatch};
use crate::state::{CaptureOutcome, ObserverStatus, Sample};
use crate::SharedState;

const CONFIG_READ_LIMIT: usize = 2_000_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStateOut {
    /// `AXIsProcessTrusted`: drives 「macOS Accessibility 已授权 / 未授权」.
    pub accessibility_trusted: bool,
    pub capture_enabled: bool,
    pub auto_show_overlay: bool,
    pub observer_running: bool,
    pub status: ObserverStatus,
    /// 正常 / 需要处理, computed from the last tick rather than from a wish.
    pub desktop_capture_ok: bool,
    pub last_tick_at: Option<String>,
    pub last_sample: Option<Sample>,
    pub min_selection_length: usize,
    pub overlay_position_mode: OverlayPositionMode,
    pub disabled_apps: Vec<String>,
    pub incompatible_apps: Vec<IncompatibleApp>,
    pub recent: Vec<CaptureOutcome>,
    pub own_window_focused: bool,
    pub api_base_url: String,
    pub mcp_endpoint: String,
    pub global_shortcut: String,
    pub device_id: String,
    pub settings_warning: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionProbeOut {
    pub ok: bool,
    /// `show` | `empty` | `whitespace_only` | `below_minimum_length` | `duplicate_selection` |
    /// `permission-disabled` | `selected-text-unsupported` | … (same vocabulary as gating.ts).
    pub reason: String,
    pub length: usize,
    pub preview: String,
    pub app_name: String,
    pub bundle_id: Option<String>,
    pub rect: Option<Rect>,
    pub captured_at: String,
    /// True when the rect is the estimated element frame rather than a real caret box.
    pub estimated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProbeOut {
    pub target: String,
    pub core_base_url: String,
    pub mcp_endpoint: String,
    pub token_configured: bool,
    pub config_path: Option<String>,
    /// Whether this companion's server entry is already present in the client's own config file —
    /// a purely local detection, no network involved.
    pub config_entry_present: bool,
    pub config_entry_detail: Option<String>,
    pub write_supported: bool,
    pub installed_apps: Vec<String>,
    /// Where the two network legs (`GET /api/health`, JSON-RPC `tools/list`) are executed and why:
    /// the native layer deliberately carries no TLS/HTTP stack in V1, and Knowledge Core answers
    /// CORS with `CORS_ORIGIN=*`, so the webview can perform the real request.
    pub network_from: &'static str,
}

fn snapshot(state: &SharedState) -> CaptureStateOut {
    let guard = state.lock();
    let trusted = ax::is_trusted(false);
    CaptureStateOut {
        accessibility_trusted: trusted,
        capture_enabled: guard.settings.capture_enabled,
        auto_show_overlay: guard.settings.auto_show_overlay,
        observer_running: guard.running,
        status: guard.status.clone(),
        desktop_capture_ok: guard.running && trusted && !needs_attention(&guard.status),
        last_tick_at: guard.last_tick_at.clone(),
        last_sample: guard.last_sample.clone(),
        min_selection_length: guard.settings.effective_min_length(),
        overlay_position_mode: guard.settings.overlay_position_mode,
        disabled_apps: guard.settings.disabled_apps.clone(),
        incompatible_apps: guard.settings.incompatible_apps.clone(),
        recent: guard.recent.iter().cloned().collect(),
        own_window_focused: guard.own_window_focused,
        api_base_url: guard.settings.api_base_url.clone(),
        mcp_endpoint: guard.settings.mcp_endpoint.clone(),
        global_shortcut: guard.settings.global_shortcut.clone(),
        device_id: guard.settings.device_id.clone(),
        settings_warning: guard.settings_warning.clone(),
    }
}

fn needs_attention(status: &ObserverStatus) -> bool {
    matches!(
        status,
        ObserverStatus::NeedsPermission | ObserverStatus::ReadFailed { .. } | ObserverStatus::Disabled
    )
}

#[tauri::command]
pub async fn capture_state(state: State<'_, SharedState>) -> Result<CaptureStateOut, String> {
    Ok(snapshot(&state))
}

/// Last selection the observer accepted — what the pill re-reads after a webview reload.
#[tauri::command]
pub fn get_selection_preview(state: State<'_, SharedState>) -> Result<Option<Sample>, String> {
    Ok(state.lock().last_sample.clone())
}

/// 「测试选区捕获」: one live, ungated read with the reason if it fails (V1 §11.2).
#[tauri::command]
pub async fn test_selection_capture(
    app: AppHandle,
    state: State<'_, SharedState>,
) -> Result<SelectionProbeOut, String> {
    let probe = observer::probe_now(&state);
    Ok(match probe {
        Probe::Found(sample) => {
            let _ = app.emit(SELECTION_CHANGED_EVENT, &sample);
            SelectionProbeOut {
                ok: true,
                reason: "show".to_string(),
                length: sample.length,
                preview: sample.preview,
                app_name: sample.app_name,
                bundle_id: sample.bundle_id,
                rect: sample.rect,
                captured_at: sample.captured_at,
                estimated: sample.estimated,
            }
        }
        Probe::NothingSelected { app: info } => SelectionProbeOut {
            ok: false,
            reason: "no-selection".to_string(),
            length: 0,
            preview: String::new(),
            app_name: info.map(|info| info.name).unwrap_or_else(|| "未知应用".to_string()),
            bundle_id: None,
            rect: None,
            captured_at: crate::time::now_iso(),
            estimated: false,
        },
        Probe::Failed { app: info, reason } => SelectionProbeOut {
            ok: false,
            reason: reason.to_string(),
            length: 0,
            preview: String::new(),
            app_name: info.map(|info| info.name).unwrap_or_else(|| "未知应用".to_string()),
            bundle_id: None,
            rect: None,
            captured_at: crate::time::now_iso(),
            estimated: false,
        },
    })
}

/// Re-run `AXIsProcessTrusted`; `prompt = true` also asks macOS to show the grant dialog.
#[tauri::command]
pub fn recheck_permission(state: State<'_, SharedState>, prompt: Option<bool>) -> Result<bool, String> {
    let trusted = ax::is_trusted(prompt.unwrap_or(false));
    let mut guard = state.lock();
    guard.last_tick_at = Some(crate::time::now_iso());
    if trusted && matches!(guard.status, ObserverStatus::NeedsPermission) {
        guard.status = ObserverStatus::Idle;
    }
    Ok(trusted)
}

/// Opens System Settings → Privacy & Security → Accessibility. Guiding the user to the official
/// switch is all we do; the grant itself is theirs (V1 §11.2, PROJECT_MASTER §2.7).
#[tauri::command]
pub fn open_accessibility_settings() -> Result<(), String> {
    mcp::open_with_system("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
}

/// Hides a companion overlay. Only the two floating windows can be hidden this way — a webview
/// must not be able to make the Setup Manager window disappear.
#[tauri::command]
pub fn hide_window(app: AppHandle, label: String) -> Result<(), String> {
    if label != overlay::OVERLAY_LABEL && label != overlay::PASTE_LABEL {
        return Err(format!("{label} 不是可隐藏的浮层"));
    }
    overlay::hide_window(&app, &label);
    Ok(())
}

#[tauri::command]
pub fn open_paste_window(app: AppHandle) -> Result<(), String> {
    overlay::open_paste(&app);
    Ok(())
}

/// Second-level fallback with the text the user already has in hand (V1 §11.4 level two).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PastePayload {
    pub text: String,
    pub app_name: Option<String>,
    pub window_title: Option<String>,
}

#[tauri::command]
pub fn paste_selection(
    app: AppHandle,
    state: State<'_, SharedState>,
    payload: PastePayload,
) -> Result<Sample, String> {
    let text = payload.text;
    if text.trim().is_empty() {
        return Err("没有可收纳的内容".to_string());
    }
    let mut guard = state.lock();
    let id = guard.next_id();
    let bounded = observer::bound_text(&text);
    let sample = Sample {
        id,
        preview: crate::state::preview_of(&bounded),
        length: bounded.chars().count(),
        text: bounded,
        app_name: payload
            .app_name
            .clone()
            .unwrap_or_else(|| "本机粘贴".to_string()),
        bundle_id: None,
        window_title: payload.window_title.clone(),
        rect: None,
        // A pasted capture has no selection to anchor to; the pill position is irrelevant here.
        estimated: true,
        captured_at: crate::time::now_iso(),
    };
    guard.record_sample(&sample);
    drop(guard);
    let _ = app.emit(SELECTION_CHANGED_EVENT, &sample);
    Ok(sample)
}

/// Master switch: stops the observer thread entirely when off (Setup Manager needs this).
#[tauri::command]
pub async fn set_capture_enabled(
    app: AppHandle,
    state: State<'_, SharedState>,
    observer: State<'_, std::sync::Arc<observer::Observer>>,
    enabled: bool,
) -> Result<CaptureStateOut, String> {
    {
        let mut guard = state.lock();
        guard.settings.capture_enabled = enabled;
        guard.persist()?;
        guard.status = if enabled {
            ObserverStatus::Idle
        } else {
            ObserverStatus::Disabled
        };
        // `running` is the thread's own report; it is only true once the loop is alive.
        guard.running = enabled;
    }
    if enabled {
        observer.start(app.clone(), (*state).clone())?;
    } else {
        observer.stop();
        state.lock().running = false;
    }
    Ok(snapshot(&state))
}

#[tauri::command]
pub fn get_settings(state: State<'_, SharedState>) -> Result<Settings, String> {
    Ok(state.lock().settings.clone())
}

#[tauri::command]
pub async fn set_settings(
    app: AppHandle,
    state: State<'_, SharedState>,
    patch: SettingsPatch,
) -> Result<Settings, String> {
    let (shortcut_changed, next) = {
        let mut guard = state.lock();
        let settings = &mut guard.settings;
        if let Some(value) = patch.api_base_url {
            settings.api_base_url = value.trim().trim_end_matches('/').to_string();
        }
        if let Some(value) = patch.api_token {
            settings.api_token = value;
        }
        if let Some(value) = patch.mcp_endpoint {
            settings.mcp_endpoint = value.trim().to_string();
        }
        if let Some(value) = patch.min_selection_length {
            settings.min_selection_length = value.max(settings::SCHEMA_MIN_TEXT_LENGTH);
        }
        if let Some(value) = patch.overlay_position_mode {
            settings.overlay_position_mode = value;
        }
        if let Some(value) = patch.capture_enabled {
            settings.capture_enabled = value;
        }
        if let Some(value) = patch.auto_show_overlay {
            settings.auto_show_overlay = value;
        }
        let shortcut_changed = patch
            .global_shortcut
            .as_ref()
            .map(|value| !value.trim().is_empty() && value.trim() != settings.global_shortcut.as_str())
            .unwrap_or(false);
        if let Some(value) = patch.global_shortcut {
            if !value.trim().is_empty() {
                settings.global_shortcut = value.trim().to_string();
            }
        }
        let next = settings.clone();
        guard.persist()?;
        (shortcut_changed, next)
    };
    if shortcut_changed {
        // A shortcut the OS refuses (taken by another app) must not lose the saved setting, so the
        // failure is reported to the UI rather than rolled back.
        crate::register_shortcut(&app)?;
    }
    Ok(next)
}

#[tauri::command]
pub fn set_app_opt_out(
    state: State<'_, SharedState>,
    app: String,
    disabled: bool,
) -> Result<Settings, String> {
    let trimmed = app.trim().to_string();
    if trimmed.is_empty() {
        return Err("应用名称为空".to_string());
    }
    let mut guard = state.lock();
    let settings = &mut guard.settings;
    settings.disabled_apps.retain(|entry| !entry.eq_ignore_ascii_case(&trimmed));
    if disabled {
        settings.disabled_apps.push(trimmed);
    }
    settings.disabled_apps.sort();
    settings.disabled_apps.dedup();
    let next = settings.clone();
    guard.persist()?;
    Ok(next)
}

#[tauri::command]
pub fn list_incompatible_apps(state: State<'_, SharedState>) -> Result<Vec<IncompatibleApp>, String> {
    Ok(observer::incompatible_entries(&state))
}

/// Forget a 「不完全兼容」 verdict so the observer gives that app another chance.
#[tauri::command]
pub fn clear_incompatible_app(
    state: State<'_, SharedState>,
    app: String,
) -> Result<Vec<IncompatibleApp>, String> {
    let mut guard = state.lock();
    guard
        .settings
        .incompatible_apps
        .retain(|entry| !entry.app.eq_ignore_ascii_case(app.trim()));
    guard
        .failure_counts
        .retain(|key, _| !key.eq_ignore_ascii_case(app.trim()));
    guard.persist()?;
    Ok(guard.settings.incompatible_apps.clone())
}

/// Resolve one client's facts against the settings currently in memory. One guard, one clone of
/// the three values: holding the lock across `mcp::resolve` would be fine but holding *two* guards
/// of the same non-reentrant mutex is not.
fn facts_for(state: &SharedState, target: &str) -> Result<TargetFacts, String> {
    let resolved = Target::from_key(target).ok_or_else(|| format!("未知的连接目标：{target}"))?;
    let (endpoint, core_base_url, token_configured) = {
        let guard = state.lock();
        (
            guard.settings.mcp_endpoint.clone(),
            guard.settings.api_base_url.clone(),
            !guard.settings.api_token.trim().is_empty(),
        )
    };
    Ok(mcp::resolve(
        resolved,
        &mcp::home_dir(),
        endpoint,
        core_base_url,
        token_configured,
    ))
}

#[tauri::command]
pub fn mcp_config_for(state: State<'_, SharedState>, target: String) -> Result<TargetFacts, String> {
    facts_for(&state, &target)
}

/// The local half of a connection test. The two network legs run in the webview (see
/// `ConnectionProbeOut::network_from` and `src/lib/connection-status.ts`), which keeps the native
/// layer free of an HTTP/TLS stack while still producing a real pass/fail.
#[tauri::command]
pub fn test_connection(
    state: State<'_, SharedState>,
    target: String,
) -> Result<ConnectionProbeOut, String> {
    let facts = facts_for(&state, &target)?;
    let (present, detail) = match facts.config_path.as_deref() {
        Some(path) => read_entry_presence(path, facts.server_name),
        None => (false, Some("该客户端没有本地配置文件".to_string())),
    };
    Ok(ConnectionProbeOut {
        target: facts.target.to_string(),
        core_base_url: facts.core_base_url,
        mcp_endpoint: facts.endpoint,
        token_configured: facts.token_configured,
        config_path: facts.config_path,
        config_entry_present: present,
        config_entry_detail: detail,
        write_supported: facts.write_supported,
        installed_apps: facts.installed_apps,
        network_from: "webview",
    })
}

fn read_entry_presence(path: &str, server_name: &str) -> (bool, Option<String>) {
    let contents = match mcp::read_text(path, CONFIG_READ_LIMIT) {
        Ok(Some(contents)) => contents,
        Ok(None) => return (false, Some("配置文件不存在".to_string())),
        Err(error) => return (false, Some(error)),
    };
    match serde_json::from_str::<serde_json::Value>(&contents) {
        Ok(value) => {
            let entry = value
                .get("mcpServers")
                .and_then(|servers| servers.get(server_name))
                .cloned();
            match entry {
                Some(entry) => (true, Some(entry.to_string())),
                None => (false, Some("配置文件中还没有知序服务器".to_string())),
            }
        }
        Err(error) => (false, Some(format!("配置文件不是合法 JSON：{error}"))),
    }
}

/// Reads a config file so the *pure* merge can happen in TypeScript (`lib/mcp-config.ts`).
#[tauri::command]
pub fn read_config_file(path: String) -> Result<Option<String>, String> {
    mcp::read_text(&path, CONFIG_READ_LIMIT)
}

/// Writes an already-merged document. The UI has shown this exact absolute path in a confirmation
/// dialog before reaching here; `Target::write_supported` and the file-name allowlist are the
/// second and third gate.
#[tauri::command]
pub fn write_mcp_config(
    state: State<'_, SharedState>,
    target: String,
    path: String,
    contents: String,
) -> Result<String, String> {
    let facts = facts_for(&state, &target)?;
    if !facts.write_supported {
        return Err("该客户端的配置不由 Setup Manager 代写".to_string());
    }
    let expected = facts
        .config_path
        .ok_or("该客户端没有配置文件写入路径".to_string())?;
    if expected != path {
        return Err(format!("拒绝写入 {path}：与 {expected} 不一致"));
    }
    // Re-validate that the document is JSON and still carries the other servers' keys.
    let parsed: serde_json::Value =
        serde_json::from_str(&contents).map_err(|error| format!("待写入内容不是合法 JSON：{error}"))?;
    let servers = parsed
        .get("mcpServers")
        .and_then(|value| value.as_object())
        .ok_or("待写入内容缺少 mcpServers 对象")?;
    if !servers.contains_key(mcp::SERVER_NAME) {
        return Err("待写入内容缺少知序服务器条目".to_string());
    }
    let written = mcp::write_text_atomically(&path, &contents)?;
    Ok(written.display().to_string())
}

#[tauri::command]
pub fn open_connection_url(target: String) -> Result<String, String> {
    let resolved = Target::from_key(&target).ok_or_else(|| format!("未知的连接目标：{target}"))?;
    let url = resolved.official_settings_url().to_string();
    mcp::open_with_system(&url)?;
    Ok(url)
}

#[tauri::command]
pub fn open_documentation(target: String) -> Result<String, String> {
    let resolved = Target::from_key(&target).ok_or_else(|| format!("未知的连接目标：{target}"))?;
    let url = resolved.docs_url().to_string();
    mcp::open_with_system(&url)?;
    Ok(url)
}

/// The overlay/paste windows report what happened; the native layer owns the log and rebroadcasts
/// it as `capture-result` so every window agrees on the last outcome.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOutcomeInput {
    pub ok: bool,
    pub length: usize,
    pub app_name: String,
    #[serde(default)]
    pub path: Vec<String>,
    pub message: String,
    /// `pill` | `paste` | `shortcut`
    pub via: String,
}

#[tauri::command]
pub fn record_capture_outcome(
    app: AppHandle,
    state: State<'_, SharedState>,
    outcome: CaptureOutcomeInput,
) -> Result<CaptureOutcome, String> {
    let stored = CaptureOutcome {
        ok: outcome.ok,
        length: outcome.length,
        app_name: outcome.app_name,
        path: outcome.path,
        message: outcome.message,
        via: outcome.via,
        at: crate::time::now_iso(),
    };
    {
        let mut guard = state.lock();
        guard.push_outcome(stored.clone());
    }
    let _ = app.emit(CAPTURE_RESULT_EVENT, &stored);
    Ok(stored)
}

/// Pill clicks hide the overlay through this instead of a window permission.
#[tauri::command]
pub fn dismiss_overlay(app: AppHandle) -> Result<(), String> {
    overlay::hide_window(&app, overlay::OVERLAY_LABEL);
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub app_name: String,
    pub bundle_id: Option<String>,
    pub version: String,
    pub config_dir: String,
    pub trusted: bool,
    pub shortcut: String,
}

#[tauri::command]
pub fn runtime_info(app: AppHandle, state: State<'_, SharedState>) -> Result<RuntimeInfo, String> {
    let guard = state.lock();
    let config_dir = guard
        .config_dir
        .as_ref()
        .map(|dir| dir.display().to_string())
        .unwrap_or_default();
    let package = app.package_info();
    Ok(RuntimeInfo {
        app_name: package.name.clone(),
        bundle_id: Some(app.config().identifier.clone()),
        version: package.version.to_string(),
        config_dir,
        trusted: ax::is_trusted(false),
        shortcut: guard.settings.global_shortcut.clone(),
    })
}
