//! In-memory runtime state, shared between the observer thread and the Tauri commands.
//!
//! The overlay gating rules are implemented twice on purpose — `src/lib/gating.ts` for the
//! frontend and [`GateReason`] here for the native observer — and both use the same reason names
//! and the same order, so a pill that the native layer decided to show is explainable by the same
//! vocabulary the Setup Manager renders.

use std::collections::{HashMap, VecDeque};

use serde::Serialize;

use crate::accessibility::ax::Rect;
use crate::settings::{Settings, PREVIEW_CHARS};

/// Observer health, straight from the last loop tick. Drives the Setup Manager row
/// 「Desktop Capture 正常 / 需要处理」.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum ObserverStatus {
    /// The thread is alive and last saw a usable selection.
    Watching,
    /// Alive, nothing captured yet.
    #[default]
    Idle,
    /// Stopped because the user turned capture off.
    Disabled,
    /// Accessibility permission missing (V1 §11.2).
    NeedsPermission,
    /// Selection belongs to our own overlay / paste window.
    OwnUiFocused,
    /// Last read failed; carries the app and the `ReadFailure` label.
    ReadFailed { app: String, reason: String },
}

/// A captured selection, ready to be pushed to the overlay.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    /// Monotonic id, so the overlay can ignore a late event for a stale selection.
    pub id: u64,
    /// Full text, capped at `MAX_CAPTURE_TEXT_LENGTH` — the pill sends exactly what it showed.
    pub text: String,
    pub preview: String,
    pub length: usize,
    pub app_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,
    /// Where the pill should appear; `None` means "centre it" (V1 §11.1 估算 failure path).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rect: Option<Rect>,
    /// `true` when `rect` is the focused element's frame rather than a real caret / selection box,
    /// so the UI can label the position 「估算」 instead of pretending to know.
    pub estimated: bool,
    pub captured_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOutcome {
    pub ok: bool,
    pub length: usize,
    pub app_name: String,
    pub path: Vec<String>,
    pub message: String,
    pub at: String,
    /// `pill` | `paste` | `shortcut` — which rung of the ladder produced it.
    pub via: String,
}

pub enum GateReason {
    Show,
    CaptureDisabled,
    PermissionMissing,
    OwnUiFocused,
    AppOptedOut,
    Empty,
    WhitespaceOnly,
    BelowMinimumLength,
    DuplicateSelection,
    IncompatibleApp,
}

impl GateReason {
    /// Stable wire label; `src/lib/gating.ts` uses the identical strings.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Show => "show",
            Self::CaptureDisabled => "capture_disabled",
            Self::PermissionMissing => "permission_missing",
            Self::OwnUiFocused => "own_ui_focused",
            Self::AppOptedOut => "app_opted_out",
            Self::Empty => "empty",
            Self::WhitespaceOnly => "whitespace_only",
            Self::BelowMinimumLength => "below_minimum_length",
            Self::DuplicateSelection => "duplicate_selection",
            Self::IncompatibleApp => "incompatible_app",
        }
    }

    pub fn is_show(&self) -> bool {
        matches!(self, Self::Show)
    }
}

#[derive(Default)]
pub struct RuntimeState {
    pub settings: Settings,
    pub status: ObserverStatus,
    /// Whether the observer thread is alive. Reported next to 「Desktop Capture」.
    pub running: bool,
    pub last_sample: Option<Sample>,
    /// Timestamp of the last loop tick, used to tell "healthy but idle" from "thread died".
    pub last_tick_at: Option<String>,
    pub own_window_focused: bool,
    /// Labels of our own windows that currently hold focus — the source of `own_window_focused`,
    /// tracked as a set so two windows handing focus over cannot leave the flag stuck on.
    focused_windows: Vec<String>,
    pub failure_counts: HashMap<String, u32>,
    pub last_text: Option<String>,
    pub recent: VecDeque<CaptureOutcome>,
    pub sequence: u64,
    pub config_dir: Option<std::path::PathBuf>,
    pub settings_warning: Option<String>,
}

impl RuntimeState {
    pub fn next_id(&mut self) -> u64 {
        self.sequence = self.sequence.wrapping_add(1);
        self.sequence
    }

    /// Called from `on_window_event`: our own pill / paste window owning the focus means the
    /// "selection" we would read is the pill's own text, so the observer must stay quiet.
    pub fn set_window_focus(&mut self, label: &str, focused: bool) {
        if focused {
            if !self.focused_windows.iter().any(|known| known == label) {
                self.focused_windows.push(label.to_string());
            }
        } else {
            self.focused_windows.retain(|known| known != label);
        }
        self.own_window_focused = !self.focused_windows.is_empty();
    }

    /// Order matters: cheap global switches first, then per-app rules, then the text itself.
    /// `settings.auto_show_overlay` is handled by the caller (it decides *visibility*, not whether
    /// the selection is worth showing at all).
    pub fn gate(&self, text: &str, app_name: &str, bundle_id: Option<&str>) -> GateReason {
        if !self.settings.capture_enabled {
            return GateReason::CaptureDisabled;
        }
        if self.own_window_focused {
            return GateReason::OwnUiFocused;
        }
        if self.settings.is_app_disabled(app_name, bundle_id) {
            return GateReason::AppOptedOut;
        }
        if self
            .settings
            .incompatible_apps
            .iter()
            .any(|entry| entry.app.eq_ignore_ascii_case(app_name))
        {
            return GateReason::IncompatibleApp;
        }
        let trimmed = text.trim();
        if text.is_empty() {
            return GateReason::Empty;
        }
        if trimmed.is_empty() {
            return GateReason::WhitespaceOnly;
        }
        if trimmed.chars().count() < self.settings.effective_min_length() {
            return GateReason::BelowMinimumLength;
        }
        if self.last_text.as_deref() == Some(trimmed) {
            return GateReason::DuplicateSelection;
        }
        GateReason::Show
    }

    pub fn record_sample(&mut self, sample: &Sample) {
        self.last_sample = Some(sample.clone());
        self.last_text = Some(sample.text.trim().to_string());
        self.status = ObserverStatus::Watching;
    }

    /// Newest first: every consumer of `recent` shows the latest outcome on top.
    pub fn push_outcome(&mut self, outcome: CaptureOutcome) {
        if self.recent.len() >= 20 {
            self.recent.pop_back();
        }
        self.recent.push_front(outcome);
    }

    pub fn persist(&self) -> Result<(), String> {
        let Some(dir) = self.config_dir.as_ref() else {
            return Ok(());
        };
        crate::settings::save(dir, &self.settings)
    }
}

/// Text preview handed to the overlay / Setup Manager: never the whole 40k selection in the UI,
/// but always enough to confirm the right thing was captured.
pub fn preview_of(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= PREVIEW_CHARS {
        return text.to_string();
    }
    let mut out: String = chars[..PREVIEW_CHARS].iter().collect();
    out.push('…');
    out
}
