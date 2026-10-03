//! Background selection observer.
//!
//! Design decision — **polling, not `AXObserver`**: a run-loop source owned by a Tauri worker
//! thread has to be created on a run loop that thread does not own, and every app activation
//! swaps the element it observes, so the registration has to be torn down and rebuilt on each
//! focus change. That re-registration is the fragile part, and when it breaks the feature fails
//! silently. A plain `std::thread` sampling every 600 ms (~1.5 samples/s, the rate V1 §11.1
//! describes) is stateless, cannot leak an observer, and costs one cross-process read per tick.
//!
//! The loop only *emits* when the selection actually changed and only when the text passes the
//! gating rules, so the cost is one AX read per tick and zero webview chatter otherwise.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use super::app_kit::AppInfo;
use super::ax::{self, ReadFailure, Rect, Selection};
use crate::overlay;
use crate::settings::{IncompatibleApp, MAX_CAPTURE_TEXT_LENGTH, INCOMPATIBLE_AFTER};
use crate::state::{preview_of, GateReason, ObserverStatus, Sample};
use crate::SharedState;

/// ~1.5 samples per second, the cadence V1 §11.1 asks for.
pub const SAMPLE_INTERVAL: Duration = Duration::from_millis(600);
/// Sleep granularity while waiting, so `stop()` is responsive.
const TICK: Duration = Duration::from_millis(50);

pub const SELECTION_CHANGED_EVENT: &str = "selection-changed";
pub const CAPTURE_RESULT_EVENT: &str = "capture-result";
pub const PASTE_REQUESTED_EVENT: &str = "paste-requested";

/// Poisoned locks are recovered instead of panicking: this thread must outlive every app the user
/// happens to be clicking in.
fn lock(shared: &SharedState) -> MutexGuard<'_, crate::state::RuntimeState> {
    shared.lock()
}

#[derive(Default)]
pub struct Observer {
    running: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Observer {
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// Idempotent: a second call while running is a no-op.
    pub fn start(&self, app: AppHandle, state: SharedState) -> Result<(), String> {
        if self.is_running() {
            return Ok(());
        }
        let running = self.running.clone();
        running.store(true, Ordering::SeqCst);
        let handle = std::thread::Builder::new()
            .name("noltri-selection-observer".to_string())
            .spawn(move || {
                while running.load(Ordering::SeqCst) {
                    // Sleep in small slices so stopping does not wait out a whole interval.
                    let mut waited = Duration::ZERO;
                    while waited < SAMPLE_INTERVAL && running.load(Ordering::SeqCst) {
                        std::thread::sleep(TICK);
                        waited += TICK;
                    }
                    if !running.load(Ordering::SeqCst) {
                        break;
                    }
                    sample_once(&app, &state);
                }
                running.store(false, Ordering::SeqCst);
            })
            .map_err(|error| error.to_string())?;
        *self.worker.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(handle);
        Ok(())
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
        let handle = self
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        if let Some(handle) = handle {
            // Joining the observer thread from the main thread is safe: it never blocks on the
            // webview, and the AX calls it makes have their own timeouts inside the OS.
            let _ = handle.join();
        }
    }
}

/// What a single raw read produced. `Found` is the only variant that may show the pill.
pub enum Probe {
    Found(Sample),
    NothingSelected { app: Option<AppInfo> },
    Failed { app: Option<AppInfo>, reason: &'static str },
}

impl Probe {
    pub fn app_name(&self) -> Option<String> {
        match self {
            Self::Found(sample) => Some(sample.app_name.clone()),
            Self::NothingSelected { app } | Self::Failed { app, .. } => app.as_ref().map(|info| info.name.clone()),
        }
    }
}

/// One ungated read: focused element → selected text → (estimated) bounds.
///
/// Also the first-level fallback of V1 §11.4: the global shortcut calls this to retry a read the
/// observer may have missed.
pub fn probe_now(state: &SharedState) -> Probe {
    if !ax::is_trusted(false) {
        let mut guard = lock(state);
        guard.status = ObserverStatus::NeedsPermission;
        guard.last_tick_at = Some(crate::time::now_iso());
        return Probe::Failed {
            app: ax::frontmost_app(),
            reason: "permission-disabled",
        };
    }
    match ax::read_selected_text() {
        Selection::Text {
            app: app_info,
            text,
            focused,
        } => {
            let bounds = ax::selection_bounds(Some(focused.element()));
            let rect = bounds.map(|bounds| bounds.rect);
            let estimated = bounds.map(|bounds| bounds.estimated).unwrap_or(true);
            let title = focused
                .focused_window_title()
                .or_else(|| focused.app_title());
            let info = app_info.clone();
            drop(focused);
            let id = {
                let mut guard = lock(state);
                guard.next_id()
            };
            let bounded = bound_text(&text);
            let sample = Sample {
                id,
                preview: preview_of(&bounded),
                length: bounded.chars().count(),
                text: bounded,
                app_name: info
                    .as_ref()
                    .map(|info| info.name.clone())
                    .unwrap_or_else(|| "未知应用".to_string()),
                bundle_id: info.as_ref().and_then(|info| info.bundle_id.clone()),
                window_title: title,
                rect,
                estimated,
                captured_at: crate::time::now_iso(),
            };
            // A successful read clears the app's strike count, so an app that merely had no
            // selection during a few ticks is never accused of being incompatible.
            let mut guard = lock(state);
            if let Some(key) = sample.bundle_id.clone().or_else(|| Some(sample.app_name.clone())) {
                guard.failure_counts.remove(&key);
            }
            drop(guard);
            Probe::Found(sample)
        }
        Selection::Empty { app } => {
            let mut guard = lock(state);
            guard.last_tick_at = Some(crate::time::now_iso());
            if guard.status != ObserverStatus::Watching {
                guard.status = ObserverStatus::Idle;
            }
            drop(guard);
            Probe::NothingSelected { app }
        }
        Selection::Failed { app, failure } => {
            note_failure(state, app.as_ref(), &failure);
            let mut guard = lock(state);
            guard.last_tick_at = Some(crate::time::now_iso());
            guard.status = ObserverStatus::ReadFailed {
                app: app
                    .as_ref()
                    .map(|info| info.name.clone())
                    .unwrap_or_else(|| "未知应用".to_string()),
                reason: failure.label().to_string(),
            };
            drop(guard);
            Probe::Failed {
                app,
                reason: failure.label(),
            }
        }
    }
}

/// Clamp to the frozen capture contract's ceiling so a pathological selection (a whole log file)
/// cannot be handed to the pipeline or to the webview.
pub fn bound_text(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= MAX_CAPTURE_TEXT_LENGTH {
        return text.to_string();
    }
    chars[..MAX_CAPTURE_TEXT_LENGTH].iter().collect()
}

fn note_failure(state: &SharedState, app: Option<&AppInfo>, failure: &ReadFailure) {
    let (Some(app), true) = (app, failure.is_permanent()) else {
        return;
    };
    let key = app.bundle_id.clone().unwrap_or_else(|| app.name.clone());
    let mut guard = lock(state);
    let count = guard.failure_counts.entry(key).or_insert(0);
    *count = count.saturating_add(1);
    if *count >= INCOMPATIBLE_AFTER {
        // V1 §11.4 level three: record the app as 「不完全兼容」 instead of writing a per-Agent
        // adapter, and keep the entry in config so a restart does not forget it.
        guard
            .settings
            .mark_incompatible(&app.name, app.bundle_id.as_deref(), failure.label());
        let _ = guard.persist();
    }
}

/// One observer tick: probe, gate, and only then talk to the webviews.
pub fn sample_once(app: &AppHandle, state: &SharedState) -> GateReason {
    let (auto_show, mode) = {
        let guard = lock(state);
        (guard.settings.auto_show_overlay, guard.settings.overlay_position_mode)
    };
    let probe = probe_now(state);
    let sample = match probe {
        Probe::Found(sample) => sample,
        Probe::NothingSelected { .. } => return GateReason::Empty,
        Probe::Failed { .. } => return GateReason::PermissionMissing,
    };

    let reason = {
        let mut guard = lock(state);
        guard.last_tick_at = Some(sample.captured_at.clone());
        let reason = guard.gate(&sample.text, &sample.app_name, sample.bundle_id.as_deref());
        if reason.is_show() {
            guard.record_sample(&sample);
        } else {
            // Anything that is not "show" still proves the pipeline is alive.
            if guard.status != ObserverStatus::Watching {
                guard.status = ObserverStatus::Idle;
            }
        }
        reason
    };

    if reason.is_show() {
        if let Err(error) = app.emit(SELECTION_CHANGED_EVENT, &sample) {
            eprintln!("[noltri] selection-changed 事件发送失败: {error}");
        }
        if auto_show {
            // This is the observer thread: NSWindow calls have to be dispatched to the main
            // thread, which is exactly what `run_on_main_thread` does without blocking us.
            let handle = app.clone();
            if let Err(error) = app.run_on_main_thread(move || overlay::show_pill(&handle, &sample, mode)) {
                eprintln!("[noltri] 浮层调度失败: {error}");
            }
        }
    }
    reason
}

/// V1 §11.4: level one is the shortcut re-read, level two is the mini paste window.
///
/// The hotkey handler runs on the main thread, and an AX read is a synchronous call into another
/// process, so the read is moved to a short-lived worker and only the window mutation comes back.
pub fn shortcut_capture(app: &AppHandle, state: &SharedState) {
    let mode = { lock(state).settings.overlay_position_mode };
    let (app, state) = (app.clone(), state.clone());
    let spawned = std::thread::Builder::new()
        .name("noltri-shortcut-read".to_string())
        .spawn(move || match probe_now(&state) {
            Probe::Found(sample) => {
                lock(&state).record_sample(&sample);
                if let Err(error) = app.emit(SELECTION_CHANGED_EVENT, &sample) {
                    eprintln!("[noltri] selection-changed 事件发送失败: {error}");
                }
                let handle = app.clone();
                if let Err(error) =
                    app.run_on_main_thread(move || overlay::show_pill(&handle, &sample, mode))
                {
                    eprintln!("[noltri] 浮层调度失败: {error}");
                }
            }
            other => {
                let reason = match &other {
                    Probe::Failed { reason, .. } => (*reason).to_string(),
                    Probe::NothingSelected { .. } => "no-selection".to_string(),
                    Probe::Found(..) => "shown".to_string(),
                };
                if let Err(error) = app.emit(
                    PASTE_REQUESTED_EVENT,
                    serde_json::json!({ "reason": reason, "app": other.app_name() }),
                ) {
                    eprintln!("[noltri] paste-requested 事件发送失败: {error}");
                }
                let handle = app.clone();
                if let Err(error) = app.run_on_main_thread(move || overlay::open_paste(&handle)) {
                    eprintln!("[noltri] 粘贴窗口调度失败: {error}");
                }
            }
        });
    if let Err(error) = spawned {
        eprintln!("[noltri] 快捷键读取线程启动失败: {error}");
    }
}

/// Entries used by Setup Manager's 「不完全兼容」 list.
pub fn incompatible_entries(state: &SharedState) -> Vec<IncompatibleApp> {
    lock(state).settings.incompatible_apps.clone()
}

/// Rect helper re-exported so commands do not reach into `ax`.
pub fn rect_is_usable(rect: Option<&Rect>) -> bool {
    rect.map(|rect| rect.width > 0.0 && rect.height > 0.0)
        .unwrap_or(false)
}
