use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::ipc::Response;
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_ASSET_BYTES: usize = 20 * 1024 * 1024;
const MAX_IMAGE_EDGE: u32 = 16_384;
const MAX_TOTAL_IMAGE_PIXELS: u64 = 64_000_000;
const ASSET_TOKEN_TTL: Duration = Duration::from_secs(120);
const MAX_INTERACTIVE_CAPTURE_TIME: Duration = Duration::from_secs(5 * 60);
pub const ACTIVATION_EVENT: &str = "noltri-intake-activation";

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ShortcutRegistration {
    Registered,
    Conflict,
    Unavailable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakeShortcutStatus {
    pub screenshot: ShortcutRegistration,
    pub open_intake: ShortcutRegistration,
    pub bindings: crate::shortcut_settings::ShortcutBindings,
    pub configuration_error: Option<String>,
}

impl Default for IntakeShortcutStatus {
    fn default() -> Self {
        Self {
            screenshot: ShortcutRegistration::Unavailable,
            open_intake: ShortcutRegistration::Unavailable,
            bindings: crate::shortcut_settings::ShortcutBindings::default(),
            configuration_error: None,
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureTraceStage {
    ActivationReceived,
    StateCheck,
    NativeCall,
    NativeResult,
    QueueEnqueue,
    BusyRelease,
    NativeEntry,
    PermissionPreflight,
    PermissionRequest,
    WindowHide,
    SystemCaptureStart,
    ClipboardWrite,
    WindowRestore,
    ShortcutReceived,
    ActivationEmit,
    NativeBusyRelease,
}

impl CaptureTraceStage {
    fn as_str(self) -> &'static str {
        match self {
            Self::ActivationReceived => "activation_received",
            Self::StateCheck => "state_check",
            Self::NativeCall => "native_call",
            Self::NativeResult => "native_result",
            Self::QueueEnqueue => "queue_enqueue",
            Self::BusyRelease => "busy_release",
            Self::NativeEntry => "native_entry",
            Self::PermissionPreflight => "permission_preflight",
            Self::PermissionRequest => "permission_request",
            Self::WindowHide => "window_hide",
            Self::SystemCaptureStart => "system_capture_start",
            Self::ClipboardWrite => "clipboard_write",
            Self::WindowRestore => "window_restore",
            Self::ShortcutReceived => "shortcut_received",
            Self::ActivationEmit => "activation_emit",
            Self::NativeBusyRelease => "native_busy_release",
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureTraceErrorCode {
    Busy,
    InvalidRequest,
    DuplicateRequest,
    Cancelled,
    PermissionDenied,
    Unsupported,
    Empty,
    NativeFailed,
    QueueRejected,
    Unexpected,
}

impl CaptureTraceErrorCode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Busy => "busy",
            Self::InvalidRequest => "invalid_request",
            Self::DuplicateRequest => "duplicate_request",
            Self::Cancelled => "cancelled",
            Self::PermissionDenied => "permission_denied",
            Self::Unsupported => "unsupported",
            Self::Empty => "empty",
            Self::NativeFailed => "native_failed",
            Self::QueueRejected => "queue_rejected",
            Self::Unexpected => "unexpected",
        }
    }
}

#[derive(Clone)]
pub(crate) struct CaptureTrace {
    request_id: String,
    started_at: Instant,
}

impl CaptureTrace {
    pub(crate) fn new(request_id: String) -> Self {
        Self {
            request_id,
            started_at: Instant::now(),
        }
    }

    pub(crate) fn log(&self, stage: CaptureTraceStage, error_code: Option<CaptureTraceErrorCode>) {
        log_capture_stage(
            &self.request_id,
            stage,
            self.started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
            error_code,
        );
    }

    pub(crate) fn request_id(&self) -> &str {
        &self.request_id
    }
}

fn valid_request_id(request_id: &str) -> bool {
    (1..=200).contains(&request_id.len())
        && request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-'))
}

fn log_capture_stage(
    request_id: &str,
    stage: CaptureTraceStage,
    elapsed_ms: u64,
    error_code: Option<CaptureTraceErrorCode>,
) {
    let _ = writeln!(
        std::io::stderr().lock(),
        "[noltri-capture] stage={} request_id={} elapsed_ms={} error={}",
        stage.as_str(),
        request_id,
        elapsed_ms,
        error_code.map_or("none", CaptureTraceErrorCode::as_str)
    );
}

#[tauri::command]
pub fn trace_capture_stage(
    request_id: String,
    stage: CaptureTraceStage,
    elapsed_ms: u64,
    error_code: Option<CaptureTraceErrorCode>,
) -> Result<(), String> {
    if !valid_request_id(&request_id) {
        return Err("invalid capture trace request ID".to_owned());
    }
    log_capture_stage(&request_id, stage, elapsed_ms, error_code);
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AssetKind {
    Screenshot,
    Clipboard,
}

struct PendingAsset {
    id: String,
    kind: AssetKind,
    bytes: Vec<u8>,
    expires_at: Instant,
}

pub struct CaptureState {
    capture_in_progress: AtomicBool,
    cancel_requested: AtomicBool,
    pending_asset: Mutex<Option<PendingAsset>>,
    shortcut_status: Mutex<IntakeShortcutStatus>,
}

impl Default for CaptureState {
    fn default() -> Self {
        Self {
            capture_in_progress: AtomicBool::new(false),
            cancel_requested: AtomicBool::new(false),
            pending_asset: Mutex::new(None),
            shortcut_status: Mutex::new(IntakeShortcutStatus::default()),
        }
    }
}

impl CaptureState {
    fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
        mutex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn is_capture_in_progress(&self) -> bool {
        self.capture_in_progress.load(Ordering::Acquire)
    }

    pub(crate) fn cancel_in_progress_capture(&self) {
        self.cancel_requested.store(true, Ordering::Release);
    }

    fn begin_capture_traced(&self, trace: CaptureTrace) -> Option<CaptureGuard<'_>> {
        self.begin_capture_inner(Some(trace))
    }

    fn begin_capture_inner(&self, trace: Option<CaptureTrace>) -> Option<CaptureGuard<'_>> {
        let guard = self
            .capture_in_progress
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| CaptureGuard { state: self, trace });
        if guard.is_some() {
            self.cancel_requested.store(false, Ordering::Release);
        }
        guard
    }

    fn invalidate_pending_asset(&self) {
        *Self::lock(&self.pending_asset) = None;
    }

    fn store_asset(&self, id: String, kind: AssetKind, bytes: Vec<u8>) {
        let pending = (bytes.len() <= MAX_ASSET_BYTES).then_some(PendingAsset {
            id,
            kind,
            bytes,
            expires_at: Instant::now() + ASSET_TOKEN_TTL,
        });
        *Self::lock(&self.pending_asset) = pending;
    }

    fn take_asset(&self, id: &str, kind: AssetKind) -> Option<Vec<u8>> {
        let mut pending = Self::lock(&self.pending_asset);
        if pending
            .as_ref()
            .is_some_and(|asset| asset.expires_at <= Instant::now())
        {
            *pending = None;
        }
        if pending
            .as_ref()
            .is_some_and(|asset| asset.id == id && asset.kind == kind)
        {
            pending.take().map(|asset| asset.bytes)
        } else {
            None
        }
    }

    pub(crate) fn set_shortcut_status(&self, status: IntakeShortcutStatus) {
        *Self::lock(&self.shortcut_status) = status;
    }
}

struct CaptureGuard<'a> {
    state: &'a CaptureState,
    trace: Option<CaptureTrace>,
}

impl Drop for CaptureGuard<'_> {
    fn drop(&mut self) {
        self.state
            .capture_in_progress
            .store(false, Ordering::Release);
        if let Some(trace) = &self.trace {
            trace.log(CaptureTraceStage::NativeBusyRelease, None);
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum BeginScreenCaptureResult {
    Captured {
        #[serde(rename = "captureId")]
        capture_id: String,
        #[serde(rename = "mimeType")]
        mime_type: &'static str,
        #[serde(rename = "byteLength")]
        byte_length: usize,
        #[serde(rename = "capturedAt")]
        captured_at: String,
        #[serde(rename = "clipboardCopied")]
        clipboard_copied: bool,
        source: Option<String>,
    },
    Cancelled {
        reason: String,
    },
    PermissionDenied {
        reason: String,
    },
    Unsupported {
        reason: String,
    },
    Empty {
        reason: String,
    },
    Busy {
        reason: String,
    },
    Failed {
        reason: String,
    },
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum ClipboardSnapshotResult {
    Available {
        #[serde(rename = "snapshotId")]
        snapshot_id: String,
        #[serde(rename = "capturedAt")]
        captured_at: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        text: Option<String>,
        #[serde(rename = "imageMimeType", skip_serializing_if = "Option::is_none")]
        image_mime_type: Option<&'static str>,
        #[serde(rename = "imageByteLength", skip_serializing_if = "Option::is_none")]
        image_byte_length: Option<usize>,
        source: Option<String>,
    },
    Empty {
        reason: String,
    },
    Unsupported {
        reason: String,
    },
    Denied {
        reason: String,
    },
    Busy {
        reason: String,
    },
    Failed {
        reason: String,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct IntakeActivation {
    action: &'static str,
    request_id: String,
}

pub(crate) fn emit_global_activation(
    app: &AppHandle,
    state: &CaptureState,
    action: &'static str,
    trace: CaptureTrace,
) {
    if action == "capture" {
        trace.log(CaptureTraceStage::StateCheck, None);
    }
    if state.is_capture_in_progress() {
        trace.log(
            CaptureTraceStage::ActivationEmit,
            Some(CaptureTraceErrorCode::Busy),
        );
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        trace.log(
            CaptureTraceStage::ActivationEmit,
            Some(CaptureTraceErrorCode::NativeFailed),
        );
        return;
    };
    if window.show().and_then(|_| window.set_focus()).is_err() {
        trace.log(
            CaptureTraceStage::ActivationEmit,
            Some(CaptureTraceErrorCode::NativeFailed),
        );
        return;
    }
    if app
        .emit(
            ACTIVATION_EVENT,
            IntakeActivation {
                action,
                request_id: trace.request_id().to_owned(),
            },
        )
        .is_err()
    {
        trace.log(
            CaptureTraceStage::ActivationEmit,
            Some(CaptureTraceErrorCode::NativeFailed),
        );
    } else {
        trace.log(CaptureTraceStage::ActivationEmit, None);
    }
}

pub fn new_request_id() -> String {
    new_id("intake")
}

fn new_id(prefix: &str) -> String {
    let sequence = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{prefix}-{nanos:x}-{sequence:x}")
}

fn rfc3339_now() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = elapsed.as_secs() as i64;
    let days = seconds.div_euclid(86_400);
    let day_seconds = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        day_seconds / 3_600,
        day_seconds % 3_600 / 60,
        day_seconds % 60,
        elapsed.subsec_millis()
    )
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let shifted = days_since_epoch + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

#[tauri::command]
pub async fn begin_screen_capture(
    request_id: String,
    app: AppHandle,
    state: State<'_, Arc<CaptureState>>,
) -> Result<BeginScreenCaptureResult, String> {
    if !valid_request_id(&request_id) {
        return Ok(BeginScreenCaptureResult::Failed {
            reason: "requestId must contain 1 to 200 safe ASCII characters".to_owned(),
        });
    }
    let trace = CaptureTrace::new(request_id.clone());
    trace.log(CaptureTraceStage::NativeEntry, None);

    #[cfg(target_os = "macos")]
    {
        let state = Arc::clone(state.inner());
        let worker_trace = trace.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            begin_screen_capture_sync(app, state, worker_trace)
        })
        .await;
        return Ok(match result {
            Ok(result) => result,
            Err(error) => {
                trace.log(
                    CaptureTraceStage::NativeResult,
                    Some(CaptureTraceErrorCode::NativeFailed),
                );
                BeginScreenCaptureResult::Failed {
                    reason: format!("native capture worker failed: {error}"),
                }
            }
        });
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, request_id);
        trace.log(
            CaptureTraceStage::NativeResult,
            Some(CaptureTraceErrorCode::Unsupported),
        );
        Ok(BeginScreenCaptureResult::Unsupported {
            reason: "screen capture is only supported on macOS".to_owned(),
        })
    }
}

#[tauri::command]
pub fn take_screen_capture_bytes(
    capture_id: String,
    state: State<'_, Arc<CaptureState>>,
) -> Result<Response, String> {
    state
        .take_asset(&capture_id, AssetKind::Screenshot)
        .map(Response::new)
        .ok_or_else(|| "screenshot bytes are missing, expired, or already consumed".to_owned())
}

#[tauri::command]
pub async fn snapshot_system_clipboard(
    request_id: String,
    app: AppHandle,
    state: State<'_, Arc<CaptureState>>,
) -> Result<ClipboardSnapshotResult, String> {
    if !valid_request_id(&request_id) {
        return Ok(ClipboardSnapshotResult::Failed {
            reason: "requestId must contain 1 to 200 safe ASCII characters".to_owned(),
        });
    }
    if state.is_capture_in_progress() {
        return Ok(ClipboardSnapshotResult::Busy {
            reason: "a screenshot is still in progress".to_owned(),
        });
    }

    #[cfg(target_os = "macos")]
    {
        let state = Arc::clone(state.inner());
        let result = tauri::async_runtime::spawn_blocking(move || {
            let _request_id = request_id;
            snapshot_system_clipboard_sync(app, state)
        })
        .await;
        return Ok(
            result.unwrap_or_else(|error| ClipboardSnapshotResult::Failed {
                reason: format!("clipboard snapshot worker failed: {error}"),
            }),
        );
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, state, request_id);
        Ok(ClipboardSnapshotResult::Unsupported {
            reason: "system clipboard snapshots are only supported on macOS".to_owned(),
        })
    }
}

#[tauri::command]
pub fn take_clipboard_snapshot(
    snapshot_id: String,
    state: State<'_, Arc<CaptureState>>,
) -> Result<Response, String> {
    state
        .take_asset(&snapshot_id, AssetKind::Clipboard)
        .map(Response::new)
        .ok_or_else(|| "clipboard image bytes are missing, expired, or already consumed".to_owned())
}

#[tauri::command]
pub fn get_intake_shortcut_status(state: State<'_, Arc<CaptureState>>) -> IntakeShortcutStatus {
    CaptureState::lock(&state.shortcut_status).to_owned()
}

#[cfg(target_os = "macos")]
fn begin_screen_capture_sync(
    app: AppHandle,
    state: Arc<CaptureState>,
    trace: CaptureTrace,
) -> BeginScreenCaptureResult {
    let Some(_capture_guard) = state.begin_capture_traced(trace.clone()) else {
        trace.log(
            CaptureTraceStage::StateCheck,
            Some(CaptureTraceErrorCode::Busy),
        );
        trace.log(
            CaptureTraceStage::NativeResult,
            Some(CaptureTraceErrorCode::Busy),
        );
        return BeginScreenCaptureResult::Busy {
            reason: "another screenshot is already being captured".to_owned(),
        };
    };
    trace.log(CaptureTraceStage::StateCheck, None);
    state.invalidate_pending_asset();

    let result = match request_screen_capture_access(&app, trace.clone()) {
        Ok(true) => match hide_capture_windows(&app, trace.clone()) {
            Ok(hidden) => {
                trace.log(CaptureTraceStage::WindowHide, None);
                let captured = run_interactive_screencapture(&state, &trace);
                drop(hidden);

                match captured {
                    Ok(bytes) => {
                        let byte_length = bytes.len();
                        let clipboard_copied =
                            match write_png_to_system_clipboard(&app, bytes.clone()) {
                                Ok(true) => {
                                    trace.log(CaptureTraceStage::ClipboardWrite, None);
                                    true
                                }
                                Ok(false) | Err(_) => {
                                    trace.log(
                                        CaptureTraceStage::ClipboardWrite,
                                        Some(CaptureTraceErrorCode::NativeFailed),
                                    );
                                    false
                                }
                            };
                        let capture_id = new_id("capture");
                        state.store_asset(capture_id.clone(), AssetKind::Screenshot, bytes);
                        BeginScreenCaptureResult::Captured {
                            capture_id,
                            mime_type: "image/png",
                            byte_length,
                            captured_at: rfc3339_now(),
                            clipboard_copied,
                            source: None,
                        }
                    }
                    Err(CaptureFailure::Cancelled(reason)) => {
                        BeginScreenCaptureResult::Cancelled { reason }
                    }
                    Err(CaptureFailure::Empty) => BeginScreenCaptureResult::Empty {
                        reason: "系统截图没有返回图像，当前收集内容保持不变。".to_owned(),
                    },
                    Err(CaptureFailure::Unsupported(reason)) => {
                        BeginScreenCaptureResult::Unsupported { reason }
                    }
                    Err(CaptureFailure::Failed(reason)) => {
                        BeginScreenCaptureResult::Failed { reason }
                    }
                }
            }
            Err(reason) => {
                trace.log(
                    CaptureTraceStage::WindowHide,
                    Some(CaptureTraceErrorCode::NativeFailed),
                );
                BeginScreenCaptureResult::Failed { reason }
            }
        },
        Ok(false) => BeginScreenCaptureResult::PermissionDenied {
            reason: "未获得屏幕录制权限。请在“系统设置 > 隐私与安全性 > 屏幕录制”允许知序后重试。"
                .to_owned(),
        },
        Err(reason) => {
            trace.log(
                CaptureTraceStage::PermissionPreflight,
                Some(CaptureTraceErrorCode::NativeFailed),
            );
            BeginScreenCaptureResult::Failed { reason }
        }
    };

    let result_error = match &result {
        BeginScreenCaptureResult::Captured { .. } => None,
        BeginScreenCaptureResult::Cancelled { .. } => Some(CaptureTraceErrorCode::Cancelled),
        BeginScreenCaptureResult::PermissionDenied { .. } => {
            Some(CaptureTraceErrorCode::PermissionDenied)
        }
        BeginScreenCaptureResult::Unsupported { .. } => Some(CaptureTraceErrorCode::Unsupported),
        BeginScreenCaptureResult::Empty { .. } => Some(CaptureTraceErrorCode::Empty),
        BeginScreenCaptureResult::Busy { .. } => Some(CaptureTraceErrorCode::Busy),
        BeginScreenCaptureResult::Failed { .. } => Some(CaptureTraceErrorCode::NativeFailed),
    };
    trace.log(CaptureTraceStage::NativeResult, result_error);
    result
}

#[cfg(target_os = "macos")]
fn snapshot_system_clipboard_sync(
    app: AppHandle,
    state: Arc<CaptureState>,
) -> ClipboardSnapshotResult {
    state.invalidate_pending_asset();
    match read_system_clipboard(&app) {
        Ok(ClipboardRead::Denied) => ClipboardSnapshotResult::Denied {
            reason: "系统拒绝了知序读取剪贴板，请在系统设置中允许后重试。".to_owned(),
        },
        Ok(ClipboardRead::Empty) => ClipboardSnapshotResult::Empty {
            reason: "剪贴板里没有可收集的文本或支持的图片。".to_owned(),
        },
        Ok(ClipboardRead::Unsupported(reason)) => ClipboardSnapshotResult::Unsupported { reason },
        Ok(ClipboardRead::Available { text, image }) => {
            let snapshot_id = new_id("clipboard");
            let (image_mime_type, image_byte_length) = match image {
                Some(image) => {
                    let length = image.bytes.len();
                    let mime_type = image.mime_type;
                    state.store_asset(snapshot_id.clone(), AssetKind::Clipboard, image.bytes);
                    (Some(mime_type), Some(length))
                }
                None => (None, None),
            };
            ClipboardSnapshotResult::Available {
                snapshot_id,
                captured_at: rfc3339_now(),
                text,
                image_mime_type,
                image_byte_length,
                source: None,
            }
        }
        Err(reason) => ClipboardSnapshotResult::Failed { reason },
    }
}

#[cfg(target_os = "macos")]
enum CaptureFailure {
    Cancelled(String),
    Empty,
    Unsupported(String),
    Failed(String),
}

#[cfg(target_os = "macos")]
fn request_screen_capture_access(app: &AppHandle, trace: CaptureTrace) -> Result<bool, String> {
    on_main_thread(app, move || unsafe {
        let preflight = CGPreflightScreenCaptureAccess();
        trace.log(
            CaptureTraceStage::PermissionPreflight,
            (!preflight).then_some(CaptureTraceErrorCode::PermissionDenied),
        );
        if preflight {
            true
        } else {
            let requested = CGRequestScreenCaptureAccess();
            trace.log(
                CaptureTraceStage::PermissionRequest,
                (!requested).then_some(CaptureTraceErrorCode::PermissionDenied),
            );
            requested
        }
    })
}

#[cfg(target_os = "macos")]
struct TempCaptureDir(std::path::PathBuf);

#[cfg(target_os = "macos")]
impl Drop for TempCaptureDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(target_os = "macos")]
fn run_interactive_screencapture(
    state: &CaptureState,
    trace: &CaptureTrace,
) -> Result<Vec<u8>, CaptureFailure> {
    use std::io::Read;
    use std::process::Stdio;

    let directory = std::env::temp_dir().join(new_id("noltri-screen"));
    create_private_capture_dir(&directory).map_err(|error| {
        trace.log(
            CaptureTraceStage::SystemCaptureStart,
            Some(CaptureTraceErrorCode::NativeFailed),
        );
        CaptureFailure::Failed(format!(
            "could not create temporary capture folder: {error}"
        ))
    })?;
    let _temporary = TempCaptureDir(directory.clone());
    let file = directory.join("capture.png");
    let mut child = std::process::Command::new("/usr/sbin/screencapture")
        .args(["-i", "-s", "-x", "-t", "png"])
        .arg(&file)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| {
            trace.log(
                CaptureTraceStage::SystemCaptureStart,
                Some(CaptureTraceErrorCode::NativeFailed),
            );
            CaptureFailure::Failed(format!("could not start /usr/sbin/screencapture: {error}"))
        })?;
    trace.log(CaptureTraceStage::SystemCaptureStart, None);
    let mut stderr = child.stderr.take();
    let stderr_reader = match std::thread::Builder::new().spawn(move || {
        let mut captured = Vec::new();
        if let Some(stderr) = stderr.as_mut() {
            let mut buffer = [0_u8; 1024];
            loop {
                match stderr.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        let remaining = 8_192_usize.saturating_sub(captured.len());
                        captured.extend_from_slice(&buffer[..read.min(remaining)]);
                    }
                }
            }
        }
        captured
    }) {
        Ok(reader) => reader,
        Err(_) => {
            terminate_capture_child(&mut child);
            return Err(CaptureFailure::Failed(
                "could not read system screenshot process output".to_owned(),
            ));
        }
    };

    let started = Instant::now();
    let status = loop {
        if state.cancel_requested.load(Ordering::Acquire) {
            terminate_capture_child(&mut child);
            let _ = stderr_reader.join();
            return Err(CaptureFailure::Failed(
                "应用退出，系统截图已取消。".to_owned(),
            ));
        }
        if started.elapsed() >= MAX_INTERACTIVE_CAPTURE_TIME {
            terminate_capture_child(&mut child);
            let _ = stderr_reader.join();
            return Err(CaptureFailure::Cancelled(
                "系统截图超过5分钟已自动结束，未加入当前批次。".to_owned(),
            ));
        }
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(error) => {
                terminate_capture_child(&mut child);
                let _ = stderr_reader.join();
                return Err(CaptureFailure::Failed(format!(
                    "could not wait for /usr/sbin/screencapture: {error}"
                )));
            }
        }
    };
    let stderr = stderr_reader.join().unwrap_or_default();

    if !status.success() {
        if !file.exists() && stderr.is_empty() {
            return Err(CaptureFailure::Cancelled("系统截图已取消。".to_owned()));
        }
        return Err(CaptureFailure::Failed(format!(
            "screencapture exited with {}: {}",
            status,
            String::from_utf8_lossy(&stderr).trim()
        )));
    }

    let metadata = match std::fs::metadata(&file) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(CaptureFailure::Empty);
        }
        Err(error) => {
            return Err(CaptureFailure::Failed(format!(
                "could not inspect screenshot output: {error}"
            )));
        }
    };
    let byte_length = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
    if byte_length == 0 {
        return Err(CaptureFailure::Empty);
    }
    if byte_length > MAX_ASSET_BYTES {
        return Err(CaptureFailure::Unsupported(format!(
            "the screenshot is {byte_length} bytes; the maximum supported size is {MAX_ASSET_BYTES} bytes"
        )));
    }

    let bytes = std::fs::read(&file).map_err(|error| {
        CaptureFailure::Failed(format!("could not read screenshot bytes: {error}"))
    })?;
    if !is_png(&bytes) {
        return Err(CaptureFailure::Unsupported(
            "截图格式不受支持，或尺寸超过16,384边长/64,000,000像素限制。".to_owned(),
        ));
    }
    Ok(bytes)
}

#[cfg(target_os = "macos")]
fn terminate_capture_child(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(target_os = "macos")]
fn create_private_capture_dir(path: &std::path::Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;

    let mut builder = std::fs::DirBuilder::new();
    builder.mode(0o700).create(path)
}

#[cfg(target_os = "macos")]
struct WindowSnapshot {
    window: tauri::WebviewWindow,
    focused: bool,
}

#[cfg(target_os = "macos")]
struct WindowRestoreGuard {
    app: AppHandle,
    windows: Vec<WindowSnapshot>,
    restored: bool,
    trace: CaptureTrace,
}

#[cfg(target_os = "macos")]
impl WindowRestoreGuard {
    fn restore(&mut self) {
        if self.restored {
            return;
        }
        self.restored = true;
        let app = self.app.clone();
        let windows = std::mem::take(&mut self.windows);
        let trace = self.trace.clone();
        match on_main_thread(&app, move || restore_windows(windows)) {
            Ok(false) => trace.log(CaptureTraceStage::WindowRestore, None),
            Ok(true) | Err(_) => trace.log(
                CaptureTraceStage::WindowRestore,
                Some(CaptureTraceErrorCode::NativeFailed),
            ),
        }
    }
}

#[cfg(target_os = "macos")]
fn restore_windows(windows: Vec<WindowSnapshot>) -> bool {
    let mut failed = false;
    for snapshot in &windows {
        if snapshot.window.show().is_err() {
            failed = true;
        }
    }
    for snapshot in windows.iter().filter(|snapshot| snapshot.focused) {
        if snapshot.window.set_focus().is_err() {
            failed = true;
        }
    }
    failed
}

#[cfg(target_os = "macos")]
impl Drop for WindowRestoreGuard {
    fn drop(&mut self) {
        self.restore();
    }
}

#[cfg(target_os = "macos")]
fn hide_capture_windows(
    app: &AppHandle,
    trace: CaptureTrace,
) -> Result<WindowRestoreGuard, String> {
    let restore_app = app.clone();
    on_main_thread(app, move || {
        let mut windows = Vec::new();
        for window in restore_app.webview_windows().into_values() {
            let visible = window
                .is_visible()
                .map_err(|error| format!("could not inspect app window visibility: {error}"))?;
            let minimized = window
                .is_minimized()
                .map_err(|error| format!("could not inspect app window minimization: {error}"))?;
            if !visible || minimized {
                continue;
            }
            let focused = window
                .is_focused()
                .map_err(|error| format!("could not inspect app window focus: {error}"))?;
            windows.push(WindowSnapshot { window, focused });
        }

        for index in 0..windows.len() {
            if let Err(error) = windows[index].window.hide() {
                let restore_failed = restore_windows(windows);
                trace.log(
                    CaptureTraceStage::WindowRestore,
                    restore_failed.then_some(CaptureTraceErrorCode::NativeFailed),
                );
                return Err(format!(
                    "could not hide an app window before capture: {error}"
                ));
            }
        }
        Ok(WindowRestoreGuard {
            app: restore_app,
            windows,
            restored: false,
            trace,
        })
    })?
}

#[cfg(target_os = "macos")]
fn write_png_to_system_clipboard(app: &AppHandle, bytes: Vec<u8>) -> Result<bool, String> {
    if bytes.is_empty() || bytes.len() > MAX_ASSET_BYTES || !is_png(&bytes) {
        return Ok(false);
    }
    on_main_thread(app, move || unsafe {
        use objc2::runtime::ProtocolObject;
        use objc2_app_kit::{
            NSPasteboard, NSPasteboardItem, NSPasteboardTypePNG, NSPasteboardWriting,
        };
        use objc2_foundation::NSArray;
        use objc2_foundation::NSData;

        let data = NSData::dataWithBytes_length(bytes.as_ptr().cast(), bytes.len() as _);
        let item = NSPasteboardItem::new();
        if !item.setData_forType(&data, NSPasteboardTypePNG) {
            return false;
        }
        let item = ProtocolObject::<dyn NSPasteboardWriting>::from_retained(item);
        let items = NSArray::from_retained_slice(&[item]);
        let pasteboard = NSPasteboard::generalPasteboard();
        // writeObjects appends; clear only after the complete PNG item is ready to replace contents.
        pasteboard.clearContents();
        pasteboard.writeObjects(&items)
    })
}

#[cfg(target_os = "macos")]
enum ClipboardRead {
    Available {
        text: Option<String>,
        image: Option<ClipboardImage>,
    },
    Empty,
    Unsupported(String),
    Denied,
}

#[cfg(target_os = "macos")]
struct ClipboardImage {
    bytes: Vec<u8>,
    mime_type: &'static str,
}

#[cfg(target_os = "macos")]
fn read_system_clipboard(app: &AppHandle) -> Result<ClipboardRead, String> {
    on_main_thread(app, read_system_clipboard_on_main)
}

#[cfg(target_os = "macos")]
fn read_system_clipboard_on_main() -> ClipboardRead {
    use objc2::runtime::AnyObject;
    use objc2::sel;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSPasteboard,
        NSPasteboardTypeTIFF,
    };
    use objc2_foundation::{NSDictionary, NSObjectProtocol, NSString};

    let pasteboard = NSPasteboard::generalPasteboard();
    if pasteboard.respondsToSelector(sel!(accessBehavior)) && pasteboard.accessBehavior().0 == 3 {
        return ClipboardRead::Denied;
    }

    let mut unsupported_image: Option<String> = None;
    let mut image = None;
    for (uti, mime) in [
        ("public.png", "image/png"),
        ("public.jpeg", "image/jpeg"),
        ("com.compuserve.gif", "image/gif"),
        ("org.webmproject.webp", "image/webp"),
    ] {
        if let Some(data) = pasteboard.dataForType(&NSString::from_str(uti)) {
            let length = data.length() as usize;
            if length == 0 || length > MAX_ASSET_BYTES {
                unsupported_image = Some(format!(
                    "clipboard image size must be between 1 and {MAX_ASSET_BYTES} bytes"
                ));
                continue;
            }
            let bytes = data_to_vec(&data);
            match validate_image_mime(&bytes, mime) {
                Ok(()) => {
                    image = Some(ClipboardImage {
                        bytes,
                        mime_type: mime,
                    });
                    break;
                }
                Err(reason) => unsupported_image = Some(reason),
            }
        }
    }

    if image.is_none() {
        if let Some(data) = unsafe { pasteboard.dataForType(NSPasteboardTypeTIFF) } {
            let length = data.length() as usize;
            if length == 0 || length > MAX_ASSET_BYTES {
                unsupported_image = Some(format!(
                    "clipboard TIFF size must be between 1 and {MAX_ASSET_BYTES} bytes"
                ));
            } else {
                let tiff_bytes = data_to_vec(&data);
                let dimensions = tiff_dimensions(&tiff_bytes);
                if !dimensions
                    .is_some_and(|(width, height)| within_image_budget(width as u64, height as u64))
                {
                    unsupported_image = Some(
                        "clipboard TIFF dimensions exceed 16,384 edge / 64,000,000 pixel limits or are invalid".to_owned(),
                    );
                    return clipboard_snapshot_without_image(&pasteboard, unsupported_image);
                }
                if let Err(reason) = validate_image_mime(&tiff_bytes, "image/tiff") {
                    unsupported_image = Some(reason);
                    return clipboard_snapshot_without_image(&pasteboard, unsupported_image);
                }
                let representation = NSBitmapImageRep::imageRepWithData(&data);
                let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
                let converted = representation
                    .and_then(|representation| unsafe {
                        let width = representation.pixelsWide();
                        let height = representation.pixelsHigh();
                        if width <= 0
                            || height <= 0
                            || !within_image_budget(width as u64, height as u64)
                        {
                            return None;
                        }
                        representation.representationUsingType_properties(
                            NSBitmapImageFileType::PNG,
                            &properties,
                        )
                    })
                    .and_then(|png| {
                        let length = png.length() as usize;
                        if length == 0 || length > MAX_ASSET_BYTES {
                            return None;
                        }
                        let bytes = data_to_vec(&png);
                        is_png(&bytes).then_some(bytes)
                    });
                image = converted.map(|bytes| ClipboardImage {
                    bytes,
                    mime_type: "image/png",
                });
                if image.is_none() {
                    unsupported_image = Some(
                        "clipboard TIFF could not be converted to PNG within the 20 MiB limit"
                            .to_owned(),
                    );
                }
            }
        }
    }

    let text = pasteboard
        .stringForType(unsafe { objc2_app_kit::NSPasteboardTypeString })
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty());

    if image.is_none() && text.is_none() {
        if let Some(reason) = unsupported_image {
            return ClipboardRead::Unsupported(reason);
        }
        let has_any_type = pasteboard.types().is_some_and(|types| types.count() > 0);
        return if has_any_type {
            ClipboardRead::Unsupported(
                "clipboard data does not contain supported text or image types".to_owned(),
            )
        } else {
            ClipboardRead::Empty
        };
    }

    ClipboardRead::Available { text, image }
}

#[cfg(target_os = "macos")]
fn clipboard_snapshot_without_image(
    pasteboard: &objc2_app_kit::NSPasteboard,
    unsupported_image: Option<String>,
) -> ClipboardRead {
    let text = pasteboard
        .stringForType(unsafe { objc2_app_kit::NSPasteboardTypeString })
        .map(|value| value.to_string())
        .filter(|value| !value.is_empty());
    match text {
        Some(text) => ClipboardRead::Available {
            text: Some(text),
            image: None,
        },
        None => ClipboardRead::Unsupported(unsupported_image.unwrap_or_else(|| {
            "clipboard image cannot be converted to a supported intake format".to_owned()
        })),
    }
}

#[cfg(target_os = "macos")]
fn data_to_vec(data: &objc2_foundation::NSData) -> Vec<u8> {
    use std::ptr::NonNull;

    let length = data.length() as usize;
    let mut bytes = vec![0; length];
    if !bytes.is_empty() {
        let pointer =
            NonNull::new(bytes.as_mut_ptr().cast()).expect("a non-empty byte vector has a pointer");
        unsafe { data.getBytes_length(pointer, length as _) };
    }
    bytes
}

#[cfg(target_os = "macos")]
fn on_main_thread<T: Send + 'static>(
    app: &AppHandle,
    action: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    if objc2_foundation::NSThread::isMainThread_class() {
        return Ok(action());
    }
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.send(action());
    })
    .map_err(|error| format!("could not schedule AppKit operation: {error}"))?;
    receiver
        .recv_timeout(Duration::from_secs(30))
        .map_err(|error| format!("AppKit operation did not finish: {error}"))
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ImageMetadataError {
    Invalid,
    MultipleFrames,
    Dimensions,
}

#[cfg(target_os = "macos")]
fn validate_image_mime(bytes: &[u8], mime: &str) -> Result<(), String> {
    let signature_matches = match mime {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n") && png_dimensions(bytes).is_some(),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP",
        "image/tiff" => tiff_dimensions(bytes).is_some(),
        _ => false,
    };
    if !signature_matches {
        return Err("剪贴板图片数据与声明格式不匹配或元数据无效。".to_owned());
    }

    imageio_dimensions(bytes)
        .map(|_| ())
        .map_err(|error| match error {
            ImageMetadataError::Invalid => "剪贴板图片尺寸元数据无法读取。".to_owned(),
            ImageMetadataError::MultipleFrames => {
                "暂不支持多帧或动画剪贴板图片，请使用单帧图片。".to_owned()
            }
            ImageMetadataError::Dimensions => {
                "剪贴板图片超过16,384边长或64,000,000像素限制。".to_owned()
            }
        })
}

#[cfg(target_os = "macos")]
fn validate_image_source_properties(
    frame_count: usize,
    width: u64,
    height: u64,
) -> Result<(), ImageMetadataError> {
    if frame_count > 1 {
        return Err(ImageMetadataError::MultipleFrames);
    }
    if frame_count == 0 {
        return Err(ImageMetadataError::Invalid);
    }
    if !within_image_budget(width, height) {
        return Err(ImageMetadataError::Dimensions);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn imageio_dimensions(bytes: &[u8]) -> Result<(u64, u64), ImageMetadataError> {
    let length = isize::try_from(bytes.len()).map_err(|_| ImageMetadataError::Invalid)?;
    let data = unsafe { CFDataCreate(std::ptr::null(), bytes.as_ptr(), length) };
    if data.is_null() {
        return Err(ImageMetadataError::Invalid);
    }
    let _data = CfReleaseGuard(data);
    let source = unsafe { CGImageSourceCreateWithData(data, std::ptr::null()) };
    if source.is_null() {
        return Err(ImageMetadataError::Invalid);
    }
    let _source = CfReleaseGuard(source);
    let frame_count = unsafe { CGImageSourceGetCount(source) };
    if frame_count > 1 {
        return Err(ImageMetadataError::MultipleFrames);
    }
    if frame_count == 0 {
        return Err(ImageMetadataError::Invalid);
    }

    let properties = unsafe { CGImageSourceCopyPropertiesAtIndex(source, 0, std::ptr::null()) };
    if properties.is_null() {
        return Err(ImageMetadataError::Invalid);
    }
    let _properties = CfReleaseGuard(properties);
    let width_number = unsafe { CFDictionaryGetValue(properties, kCGImagePropertyPixelWidth) };
    let height_number = unsafe { CFDictionaryGetValue(properties, kCGImagePropertyPixelHeight) };
    if width_number.is_null() || height_number.is_null() {
        return Err(ImageMetadataError::Invalid);
    }

    let mut width = 0_i64;
    let mut height = 0_i64;
    let width_read = unsafe {
        CFNumberGetValue(
            width_number,
            CF_NUMBER_SINT64_TYPE,
            (&mut width as *mut i64).cast(),
        )
    };
    let height_read = unsafe {
        CFNumberGetValue(
            height_number,
            CF_NUMBER_SINT64_TYPE,
            (&mut height as *mut i64).cast(),
        )
    };
    if width_read == 0 || height_read == 0 || width <= 0 || height <= 0 {
        return Err(ImageMetadataError::Invalid);
    }
    let width = width as u64;
    let height = height as u64;
    validate_image_source_properties(frame_count, width, height)?;
    Ok((width, height))
}

#[cfg(target_os = "macos")]
struct CfReleaseGuard(*const std::ffi::c_void);

#[cfg(target_os = "macos")]
impl Drop for CfReleaseGuard {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) };
    }
}

fn is_png(bytes: &[u8]) -> bool {
    png_dimensions(bytes).is_some()
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    within_image_budget(width as u64, height as u64).then_some((width, height))
}

fn within_image_budget(width: u64, height: u64) -> bool {
    width > 0
        && height > 0
        && width <= MAX_IMAGE_EDGE as u64
        && height <= MAX_IMAGE_EDGE as u64
        && width
            .checked_mul(height)
            .is_some_and(|pixels| pixels <= MAX_TOTAL_IMAGE_PIXELS)
}

fn tiff_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let little_endian = match bytes.get(0..2)? {
        b"II" => true,
        b"MM" => false,
        _ => return None,
    };
    if read_tiff_u16(bytes, 2, little_endian)? != 42 {
        return None;
    }
    let ifd_offset = read_tiff_u32(bytes, 4, little_endian)? as usize;
    let count = read_tiff_u16(bytes, ifd_offset, little_endian)? as usize;
    let entries_start = ifd_offset.checked_add(2)?;
    let entries_end = entries_start.checked_add(count.checked_mul(12)?)?;
    if entries_end > bytes.len() {
        return None;
    }

    let mut width = None;
    let mut height = None;
    for entry_offset in (entries_start..entries_end).step_by(12) {
        let tag = read_tiff_u16(bytes, entry_offset, little_endian)?;
        if tag != 256 && tag != 257 {
            continue;
        }
        let value_type = read_tiff_u16(bytes, entry_offset + 2, little_endian)?;
        let value_count = read_tiff_u32(bytes, entry_offset + 4, little_endian)?;
        if value_count == 0 {
            continue;
        }
        let value_field = entry_offset + 8;
        let value = match value_type {
            3 => {
                let byte_count = value_count.checked_mul(2)? as usize;
                if byte_count <= 4 {
                    read_tiff_u16(bytes, value_field, little_endian)? as u32
                } else {
                    let values_offset = read_tiff_u32(bytes, value_field, little_endian)? as usize;
                    read_tiff_u16(bytes, values_offset, little_endian)? as u32
                }
            }
            4 => {
                if value_count == 1 {
                    read_tiff_u32(bytes, value_field, little_endian)?
                } else {
                    let values_offset = read_tiff_u32(bytes, value_field, little_endian)? as usize;
                    read_tiff_u32(bytes, values_offset, little_endian)?
                }
            }
            _ => return None,
        };
        if tag == 256 {
            width = Some(value);
        } else {
            height = Some(value);
        }
    }
    Some((width?, height?))
}

fn read_tiff_u16(bytes: &[u8], offset: usize, little_endian: bool) -> Option<u16> {
    let value: [u8; 2] = bytes.get(offset..offset.checked_add(2)?)?.try_into().ok()?;
    Some(if little_endian {
        u16::from_le_bytes(value)
    } else {
        u16::from_be_bytes(value)
    })
}

fn read_tiff_u32(bytes: &[u8], offset: usize, little_endian: bool) -> Option<u32> {
    let value: [u8; 4] = bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?;
    Some(if little_endian {
        u32::from_le_bytes(value)
    } else {
        u32::from_be_bytes(value)
    })
}

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

#[cfg(target_os = "macos")]
const CF_NUMBER_SINT64_TYPE: isize = 4; // kCFNumberSInt64Type in CoreFoundation's public SDK.

#[cfg(target_os = "macos")]
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFDataCreate(
        allocator: *const std::ffi::c_void,
        bytes: *const u8,
        length: isize,
    ) -> *const std::ffi::c_void;
    fn CFRelease(value: *const std::ffi::c_void);
    fn CFDictionaryGetValue(
        dictionary: *const std::ffi::c_void,
        key: *const std::ffi::c_void,
    ) -> *const std::ffi::c_void;
    fn CFNumberGetValue(
        number: *const std::ffi::c_void,
        number_type: isize,
        value: *mut std::ffi::c_void,
    ) -> u8;
}

#[cfg(target_os = "macos")]
#[link(name = "ImageIO", kind = "framework")]
extern "C" {
    fn CGImageSourceCreateWithData(
        data: *const std::ffi::c_void,
        options: *const std::ffi::c_void,
    ) -> *const std::ffi::c_void;
    fn CGImageSourceGetCount(source: *const std::ffi::c_void) -> usize;
    fn CGImageSourceCopyPropertiesAtIndex(
        source: *const std::ffi::c_void,
        index: usize,
        options: *const std::ffi::c_void,
    ) -> *const std::ffi::c_void;
    static kCGImagePropertyPixelWidth: *const std::ffi::c_void;
    static kCGImagePropertyPixelHeight: *const std::ffi::c_void;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asset_tokens_are_single_use_kind_bound_and_expire_on_replacement() {
        let state = CaptureState::default();
        state.store_asset("one".to_owned(), AssetKind::Screenshot, vec![1, 2, 3]);
        assert_eq!(state.take_asset("one", AssetKind::Clipboard), None);
        assert_eq!(
            state.take_asset("one", AssetKind::Screenshot),
            Some(vec![1, 2, 3])
        );
        assert_eq!(state.take_asset("one", AssetKind::Screenshot), None);

        state.store_asset("old".to_owned(), AssetKind::Screenshot, vec![4]);
        state.store_asset("new".to_owned(), AssetKind::Clipboard, vec![5]);
        assert_eq!(state.take_asset("old", AssetKind::Screenshot), None);
        assert_eq!(state.take_asset("new", AssetKind::Clipboard), Some(vec![5]));
    }

    #[test]
    fn capture_is_single_flight_and_releases_after_scope() {
        let state = CaptureState::default();
        let guard = state
            .begin_capture_inner(None)
            .expect("first capture should begin");
        assert!(state.begin_capture_inner(None).is_none());
        drop(guard);
        assert!(state.begin_capture_inner(None).is_some());
    }

    #[test]
    fn capture_guard_can_be_reacquired_after_every_terminal_path() {
        let state = CaptureState::default();
        for (terminal, outcome) in [
            ("success", Ok(())),
            ("cancelled", Err("cancelled")),
            ("permission_denied", Err("permission denied")),
            ("failed", Err("native failure")),
            ("child_timeout", Err("child timeout")),
        ] {
            let observed = {
                let _guard = state
                    .begin_capture_inner(None)
                    .expect("capture should begin");
                outcome
            };
            assert_eq!(observed.is_ok(), terminal == "success");
            assert!(
                state.begin_capture_inner(None).is_some(),
                "retry after {terminal}"
            );
        }

        let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = state
                .begin_capture_inner(None)
                .expect("capture should begin");
            panic!("simulated native failure");
        }));
        assert!(panic.is_err());
        assert!(
            state.begin_capture_inner(None).is_some(),
            "retry after panic"
        );
    }

    #[test]
    fn request_ids_and_timestamps_are_usable_strings() {
        let request_id = new_request_id();
        assert!(request_id.starts_with("intake-"));
        assert!(valid_request_id(&request_id));
        let timestamp = rfc3339_now();
        assert!(timestamp.ends_with('Z'));
        assert_eq!(timestamp.len(), 24);
    }

    #[test]
    fn request_ids_for_trace_logs_reject_control_and_non_ascii_characters() {
        assert!(valid_request_id("ui-01234567-89ab-cdef"));
        assert!(valid_request_id("intake-deadbeef-1"));
        assert!(!valid_request_id(""));
        assert!(!valid_request_id("ui-request\nprivate"));
        assert!(!valid_request_id("截图"));
        assert!(!valid_request_id(&"x".repeat(201)));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn capture_child_is_reaped_before_the_guard_can_be_reacquired() {
        let state = CaptureState::default();
        let guard = state
            .begin_capture_inner(None)
            .expect("capture should begin");
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("sleep test child should start");

        terminate_capture_child(&mut child);
        assert!(child
            .try_wait()
            .expect("child status should be readable")
            .is_some());
        drop(guard);
        assert!(state.begin_capture_inner(None).is_some());
    }

    #[test]
    fn trace_ipc_accepts_only_whitelisted_stages_and_error_codes() {
        assert_eq!(
            serde_json::from_str::<CaptureTraceStage>("\"system_capture_start\"")
                .unwrap()
                .as_str(),
            "system_capture_start"
        );
        assert!(serde_json::from_str::<CaptureTraceStage>("\"clipboard payload\"").is_err());
        assert_eq!(
            serde_json::from_str::<CaptureTraceErrorCode>("\"permission_denied\"")
                .unwrap()
                .as_str(),
            "permission_denied"
        );
        assert!(serde_json::from_str::<CaptureTraceErrorCode>("\"private detail\"").is_err());
    }

    #[test]
    fn screenshot_png_validation_rejects_empty_malformed_and_zero_sized_images() {
        let mut png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01\0\0\0\x01".to_vec();
        assert!(is_png(&png));
        png[19] = 0;
        png[20] = 0;
        png[21] = 0;
        png[22] = 0;
        png[23] = 0;
        assert!(!is_png(&png));
        assert!(!is_png(b""));
        assert!(!is_png(b"not an image"));
    }

    #[test]
    fn image_budget_checks_edges_pixels_and_multiplication_overflow() {
        assert!(within_image_budget(8_000, 8_000));
        assert!(within_image_budget(16_384, 3_906));
        assert!(!within_image_budget(16_385, 1));
        assert!(!within_image_budget(8_001, 8_000));
        assert!(!within_image_budget(u64::MAX, u64::MAX));

        let oversized_png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\x00\x00\x40\x01\x00\x00\x00\x01";
        assert!(!is_png(oversized_png));
    }

    #[test]
    fn tiff_header_dimensions_support_both_byte_orders_and_reject_bad_offsets() {
        for little_endian in [true, false] {
            let bytes = test_tiff_dimensions(little_endian, 1_920, 1_080);
            assert_eq!(tiff_dimensions(&bytes), Some((1_920, 1_080)));

            let oversized = test_tiff_dimensions(little_endian, 16_385, 1);
            let (width, height) = tiff_dimensions(&oversized).unwrap();
            assert!(!within_image_budget(width as u64, height as u64));
        }

        assert_eq!(tiff_dimensions(b"II*\0\xff\xff\xff\xff"), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn capture_temp_directory_is_private_and_removed() {
        use std::os::unix::fs::PermissionsExt;

        let path = std::env::temp_dir().join(new_id("noltri-screen-test"));
        create_private_capture_dir(&path).expect("private capture directory should be created");
        let temporary = TempCaptureDir(path.clone());
        let mode = std::fs::metadata(&path)
            .expect("capture directory should exist")
            .permissions()
            .mode();

        assert_eq!(mode & 0o077, 0);
        drop(temporary);
        assert!(!path.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn image_metadata_rejects_multiframe_and_over_budget_sources() {
        assert_eq!(validate_image_source_properties(1, 1_920, 1_080), Ok(()));
        assert_eq!(
            validate_image_source_properties(2, 1_920, 1_080),
            Err(ImageMetadataError::MultipleFrames)
        );
        assert_eq!(
            validate_image_source_properties(0, 1, 1),
            Err(ImageMetadataError::Invalid)
        );
        assert_eq!(
            validate_image_source_properties(1, 16_385, 1),
            Err(ImageMetadataError::Dimensions)
        );
        assert_eq!(
            validate_image_source_properties(1, 8_001, 8_000),
            Err(ImageMetadataError::Dimensions)
        );
    }

    fn test_tiff_dimensions(little_endian: bool, width: u32, height: u32) -> Vec<u8> {
        fn append_u16(bytes: &mut Vec<u8>, value: u16, little_endian: bool) {
            let encoded = if little_endian {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            };
            bytes.extend_from_slice(&encoded);
        }
        fn append_u32(bytes: &mut Vec<u8>, value: u32, little_endian: bool) {
            let encoded = if little_endian {
                value.to_le_bytes()
            } else {
                value.to_be_bytes()
            };
            bytes.extend_from_slice(&encoded);
        }

        let mut bytes = if little_endian {
            b"II".to_vec()
        } else {
            b"MM".to_vec()
        };
        append_u16(&mut bytes, 42, little_endian);
        append_u32(&mut bytes, 8, little_endian);
        append_u16(&mut bytes, 2, little_endian);
        for (tag, value) in [(256_u16, width), (257_u16, height)] {
            append_u16(&mut bytes, tag, little_endian);
            append_u16(&mut bytes, 4, little_endian); // TIFF LONG
            append_u32(&mut bytes, 1, little_endian);
            append_u32(&mut bytes, value, little_endian);
        }
        append_u32(&mut bytes, 0, little_endian);
        bytes
    }
}
