//! Persisted app configuration (`<app config dir>/settings.json`).
//!
//! Only *our own* configuration lives here: the Knowledge Core base URL, the device token the
//! user pasted in, gating thresholds, the per-app opt-out list and the 「不完全兼容」 list.
//! Third-party credentials are never stored (PROJECT_MASTER §2.7) — Setup Manager only detects,
//! guides and prepares config.

use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Mirrors `MIN_CAPTURE_TEXT_LENGTH` in `@noltri/schema`: the frozen capture contract rejects
/// anything shorter, so a smaller setting would only produce guaranteed failures.
pub const SCHEMA_MIN_TEXT_LENGTH: usize = 8;
pub const MAX_CAPTURE_TEXT_LENGTH: usize = 40_000;
/// Preview text handed to the overlay / Setup Manager.
pub const PREVIEW_CHARS: usize = 280;
/// Consecutive permanent failures for one app before it is recorded as 「不完全兼容」 (V1 §11.4).
pub const INCOMPATIBLE_AFTER: u32 = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum OverlayPositionMode {
    /// Pill under the selection box.
    #[default]
    Selection,
    /// Pill next to the caret / estimated point.
    Caret,
    /// Screen-centred — the fallback when coordinates are unusable.
    Center,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncompatibleApp {
    pub app: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    /// `ReadFailure::label()` of the last permanent failure.
    pub reason: String,
    pub attempts: u32,
    pub last_seen: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub api_base_url: String,
    /// Device token for Knowledge Core (`NOLTRI_ACCESS_TOKEN`). Not a third-party credential.
    pub api_token: String,
    pub mcp_endpoint: String,
    pub min_selection_length: usize,
    pub overlay_position_mode: OverlayPositionMode,
    /// Master switch: Setup Manager can stop the observer entirely.
    pub capture_enabled: bool,
    /// Show the pill automatically on a new selection; off = shortcut only (V1 §11.4 level one).
    pub auto_show_overlay: bool,
    pub global_shortcut: String,
    /// Bundle ids or app names the user opted out of (mirrors the extension's disabled sites).
    pub disabled_apps: Vec<String>,
    pub incompatible_apps: Vec<IncompatibleApp>,
    pub device_id: String,
}

impl Default for Settings {
    fn default() -> Self {
        let base = env_or("NOLTRI_API_BASE_URL", "http://localhost:8787");
        Self {
            mcp_endpoint: env_or("NOLTRI_MCP_ENDPOINT", &format!("{base}/mcp")),
            api_base_url: base,
            api_token: env_or("NOLTRI_ACCESS_TOKEN", ""),
            min_selection_length: SCHEMA_MIN_TEXT_LENGTH.max(12),
            overlay_position_mode: OverlayPositionMode::default(),
            capture_enabled: true,
            auto_show_overlay: true,
            global_shortcut: env_or("NOLTRI_DESKTOP_SHORTCUT", "Cmd+Shift+K"),
            disabled_apps: Vec::new(),
            incompatible_apps: Vec::new(),
            device_id: env_or("NOLTRI_DEVICE_ID", "desktop-macos"),
        }
    }
}

fn env_or(key: &str, fallback: &str) -> String {
    match std::env::var(key) {
        Ok(value) if !value.trim().is_empty() => value.trim().to_string(),
        _ => fallback.to_string(),
    }
}

impl Settings {
    pub fn effective_min_length(&self) -> usize {
        self.min_selection_length.max(SCHEMA_MIN_TEXT_LENGTH)
    }

    /// Per-app opt-out, matched on bundle id first and then on a case-insensitive name, so a
    /// manually typed entry works even when the app reports no bundle id.
    pub fn is_app_disabled(&self, name: &str, bundle_id: Option<&str>) -> bool {
        if self.disabled_apps.is_empty() {
            return false;
        }
        let lowered_name = name.trim().to_lowercase();
        let lowered_bundle = bundle_id.map(|value| value.trim().to_lowercase());
        self.disabled_apps.iter().any(|entry| {
            let needle = entry.trim().to_lowercase();
            if needle.is_empty() {
                return false;
            }
            if let Some(bundle) = lowered_bundle.as_deref() {
                if bundle == needle {
                    return true;
                }
            }
            lowered_name == needle
        })
    }

    pub fn mark_incompatible(&mut self, app: &str, bundle_id: Option<&str>, reason: &str) {
        let now = crate::time::now_iso();
        if let Some(existing) = self
            .incompatible_apps
            .iter_mut()
            .find(|entry| entry.app.eq_ignore_ascii_case(app))
        {
            existing.reason = reason.to_string();
            existing.last_seen = now;
            existing.attempts = existing.attempts.saturating_add(1);
            return;
        }
        self.incompatible_apps.push(IncompatibleApp {
            app: app.to_string(),
            bundle_id: bundle_id.map(str::to_string),
            reason: reason.to_string(),
            attempts: 1,
            last_seen: now,
        });
        // Bounded list: keep the most recent 40 entries.
        if self.incompatible_apps.len() > 40 {
            let overflow = self.incompatible_apps.len() - 40;
            self.incompatible_apps.drain(0..overflow);
        }
    }
}

/// Partial update from `set_settings`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SettingsPatch {
    pub api_base_url: Option<String>,
    pub api_token: Option<String>,
    pub mcp_endpoint: Option<String>,
    pub min_selection_length: Option<usize>,
    pub overlay_position_mode: Option<OverlayPositionMode>,
    pub capture_enabled: Option<bool>,
    pub auto_show_overlay: Option<bool>,
    pub global_shortcut: Option<String>,
}

pub fn settings_path(config_dir: &Path) -> PathBuf {
    config_dir.join("settings.json")
}

pub fn load(config_dir: &Path) -> (Settings, Option<String>) {
    let path = settings_path(config_dir);
    match fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<Settings>(&raw) {
            Ok(settings) => (sanitise(settings), None),
            Err(error) => (
                Settings::default(),
                Some(format!("settings.json 无法解析（{error}），已使用默认值")),
            ),
        },
        Err(_) => (Settings::default(), None),
    }
}

fn sanitise(mut settings: Settings) -> Settings {
    settings.api_base_url = settings.api_base_url.trim().trim_end_matches('/').to_string();
    if settings.api_base_url.is_empty() {
        settings.api_base_url = Settings::default().api_base_url;
    }
    if settings.mcp_endpoint.trim().is_empty() {
        settings.mcp_endpoint = format!("{}/mcp", settings.api_base_url);
    }
    settings.min_selection_length = settings.min_selection_length.max(SCHEMA_MIN_TEXT_LENGTH);
    settings
        .disabled_apps
        .retain(|entry| !entry.trim().is_empty());
    let unique: BTreeSet<String> = settings
        .disabled_apps
        .iter()
        .map(|entry| entry.trim().to_lowercase())
        .collect();
    settings.disabled_apps = unique.into_iter().collect();
    settings
}

/// Write atomically: temp file in the same directory + rename, so a crash mid-write can never
/// leave a half-written settings file behind.
pub fn save(config_dir: &Path, settings: &Settings) -> Result<(), String> {
    fs::create_dir_all(config_dir).map_err(|error| error.to_string())?;
    let path = settings_path(config_dir);
    let tmp = path.with_extension("json.tmp");
    let payload = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    let mut handle = fs::File::create(&tmp).map_err(|error| error.to_string())?;
    handle
        .write_all(payload.as_bytes())
        .and_then(|_| handle.sync_all())
        .map_err(|error| error.to_string())?;
    drop(handle);
    fs::rename(&tmp, &path).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn min_length_never_drops_below_the_frozen_contract() {
        let settings = Settings {
            min_selection_length: 2,
            ..Settings::default()
        };
        assert_eq!(settings.effective_min_length(), SCHEMA_MIN_TEXT_LENGTH);
    }

    #[test]
    fn opt_out_matches_bundle_id_or_name_case_insensitively() {
        let settings = Settings {
            disabled_apps: vec!["com.example.codex".into()],
            ..Settings::default()
        };
        assert!(settings.is_app_disabled("Codex", Some("com.example.Codex")));
        assert!(!settings.is_app_disabled("Qoder", Some("com.qoder.app")));
        let by_name = Settings {
            disabled_apps: vec!["  Terminal ".into()],
            ..Settings::default()
        };
        assert!(by_name.is_app_disabled("terminal", None));
    }

    #[test]
    fn incompatible_list_is_deduplicated_and_bounded() {
        let mut settings = Settings::default();
        settings.mark_incompatible("WeirdApp", Some("com.weird"), "selected-text-unsupported");
        settings.mark_incompatible("WeirdApp", Some("com.weird"), "selected-text-unsupported");
        assert_eq!(settings.incompatible_apps.len(), 1);
        assert_eq!(settings.incompatible_apps[0].attempts, 2);
    }
}
