use serde::{Deserialize, Serialize};
use std::ffi::{c_char, c_void, CStr};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

pub const AX_SELECTION_ACCEPTED_EVENT: &str = "noltri-ax-selection-accepted";
const MAX_SELECTION_CHARS: usize = 20_000;
const SUPPORTED_BUNDLE_IDS: [&str; 2] = ["com.apple.TextEdit", "com.apple.Notes"];

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AxSelectionOfferStatus {
    pub enabled: bool,
    pub permission: &'static str,
}

pub struct AxSelectionOfferState {
    callback_context: Mutex<Option<usize>>,
}

impl Default for AxSelectionOfferState {
    fn default() -> Self {
        Self { callback_context: Mutex::new(None) }
    }
}

impl AxSelectionOfferState {
    fn context(&self) -> std::sync::MutexGuard<'_, Option<usize>> {
        self.callback_context.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum AxSelectionEvent {
    Accepted {
        #[serde(rename = "requestId")]
        request_id: String,
        text: String,
        #[serde(rename = "appName")]
        app_name: String,
        #[serde(rename = "bundleId")]
        bundle_id: String,
    },
}

impl AxSelectionEvent {
    fn is_valid(&self) -> bool {
        match self {
            Self::Accepted { request_id, text, app_name, bundle_id } => {
                valid_ax_request_id(request_id)
                    && !text.trim().is_empty()
                    && text.chars().count() <= MAX_SELECTION_CHARS
                    && !app_name.trim().is_empty()
                    && app_name.chars().count() <= 100
                    && SUPPORTED_BUNDLE_IDS.contains(&bundle_id.as_str())
            }
        }
    }
}

fn valid_ax_request_id(value: &str) -> bool {
    let Some(uuid) = value.strip_prefix("ax-") else { return false };
    uuid.len() == 36
        && uuid.bytes().enumerate().all(|(index, byte)| {
            if [8, 13, 18, 23].contains(&index) { byte == b'-' }
            else { byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) }
        })
}

unsafe extern "C" fn on_ax_selection_accepted(context: *mut c_void, message: *const c_char) {
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if context.is_null() || message.is_null() { return; }
        let app_pointer = context.cast::<AppHandle>();
        // The service owns the original Arc until it is synchronously stopped on the main thread.
        unsafe { Arc::increment_strong_count(app_pointer) };
        let app = unsafe { Arc::from_raw(app_pointer) };
        let Ok(message) = unsafe { CStr::from_ptr(message) }.to_str() else { return; };
        let Ok(event) = serde_json::from_str::<AxSelectionEvent>(message) else { return; };
        if !event.is_valid() { return; }

        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
        let _ = app.emit(AX_SELECTION_ACCEPTED_EVENT, event);
    }));
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn noltri_ax_offer_is_enabled() -> i32;
    fn noltri_ax_offer_check_trust() -> i32;
    fn noltri_ax_offer_start_if_enabled(
        context: *mut c_void,
        callback: unsafe extern "C" fn(*mut c_void, *const c_char),
    ) -> i32;
    fn noltri_ax_offer_set_enabled(
        enabled: i32,
        context: *mut c_void,
        callback: unsafe extern "C" fn(*mut c_void, *const c_char),
    ) -> i32;
    fn noltri_ax_offer_stop();
}

#[cfg(target_os = "macos")]
fn new_context(app: &AppHandle) -> (*mut c_void, usize) {
    let pointer = Arc::into_raw(Arc::new(app.clone()));
    (pointer.cast_mut().cast(), pointer as usize)
}

#[cfg(target_os = "macos")]
fn free_context(context: usize) {
    let pointer = context as *const AppHandle;
    if !pointer.is_null() { unsafe { drop(Arc::from_raw(pointer)); } }
}

#[cfg(target_os = "macos")]
fn start_if_enabled(app: &AppHandle, state: &AxSelectionOfferState) -> AxSelectionOfferStatus {
    let enabled = unsafe { noltri_ax_offer_is_enabled() != 0 };
    if !enabled { return AxSelectionOfferStatus { enabled: false, permission: "not_checked" }; }
    if unsafe { noltri_ax_offer_check_trust() == 0 } {
        return AxSelectionOfferStatus { enabled: true, permission: "denied" };
    }
    if state.context().is_some() {
        return AxSelectionOfferStatus { enabled: true, permission: "granted" };
    }
    let (raw_context, owned_context) = new_context(app);
    let result = unsafe { noltri_ax_offer_start_if_enabled(raw_context, on_ax_selection_accepted) };
    if result == 1 {
        *state.context() = Some(owned_context);
        AxSelectionOfferStatus { enabled: true, permission: "granted" }
    } else {
        free_context(owned_context);
        AxSelectionOfferStatus { enabled: true, permission: "denied" }
    }
}

#[cfg(not(target_os = "macos"))]
fn start_if_enabled(_app: &AppHandle, _state: &AxSelectionOfferState) -> AxSelectionOfferStatus {
    AxSelectionOfferStatus { enabled: false, permission: "unsupported" }
}

pub fn stop(state: &AxSelectionOfferState) {
    #[cfg(target_os = "macos")]
    {
        unsafe { noltri_ax_offer_stop(); }
        if let Some(context) = state.context().take() { free_context(context); }
    }
}

#[tauri::command]
pub async fn start_ax_selection_offers_if_enabled(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, Arc<AxSelectionOfferState>>,
) -> Result<AxSelectionOfferStatus, String> {
    if window.label() != "main" {
        return Err("window_command_forbidden".to_owned());
    }
    let state = Arc::clone(state.inner());
    let scheduled_app = app.clone();
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    app.run_on_main_thread(move || {
        let result = if scheduled_app.get_webview_window("main").is_some() {
            Ok(start_if_enabled(&scheduled_app, state.as_ref()))
        } else {
            Err("main_window_unavailable".to_owned())
        };
        let _ = sender.try_send(result);
    }).map_err(|_| "ax_offer_main_thread_unavailable".to_owned())?;
    receiver.recv().await.ok_or_else(|| "ax_offer_main_thread_unavailable".to_owned())?
}

#[tauri::command]
pub fn get_ax_selection_offer_status(
    app: AppHandle,
    state: State<'_, Arc<AxSelectionOfferState>>,
) -> AxSelectionOfferStatus {
    #[cfg(target_os = "macos")]
    {
        let _ = (app, state.inner());
        let enabled = unsafe { noltri_ax_offer_is_enabled() != 0 };
        let permission = if !enabled { "not_checked" }
            else if unsafe { noltri_ax_offer_check_trust() != 0 } { "granted" }
            else { "denied" };
        AxSelectionOfferStatus { enabled, permission }
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (app, state); AxSelectionOfferStatus { enabled: false, permission: "unsupported" } }
}

#[tauri::command]
pub async fn set_ax_selection_offers_enabled(
    enabled: bool,
    app: AppHandle,
    state: State<'_, Arc<AxSelectionOfferState>>,
) -> Result<AxSelectionOfferStatus, String> {
    #[cfg(target_os = "macos")]
    {
        let state = Arc::clone(state.inner());
        let scheduled_app = app.clone();
        let (sender, mut receiver) = tauri::async_runtime::channel(1);
        app.run_on_main_thread(move || {
            let result = set_enabled_on_main_thread(enabled, &scheduled_app, &state);
            let _ = sender.try_send(result);
        }).map_err(|_| "ax_offer_main_thread_unavailable".to_owned())?;
        return receiver.recv().await.ok_or_else(|| "ax_offer_main_thread_unavailable".to_owned())?;
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (enabled, app, state); Ok(AxSelectionOfferStatus { enabled: false, permission: "unsupported" }) }
}

#[cfg(target_os = "macos")]
fn set_enabled_on_main_thread(
    enabled: bool,
    app: &AppHandle,
    state: &AxSelectionOfferState,
) -> Result<AxSelectionOfferStatus, String> {
    if enabled {
        if unsafe { noltri_ax_offer_check_trust() == 0 } {
            return Ok(AxSelectionOfferStatus { enabled: false, permission: "denied" });
        }
        if state.context().is_some() {
            return Ok(AxSelectionOfferStatus { enabled: true, permission: "granted" });
        }
        let (raw_context, owned_context) = new_context(app);
        let result = unsafe { noltri_ax_offer_set_enabled(1, raw_context, on_ax_selection_accepted) };
        if result == 1 {
            *state.context() = Some(owned_context);
            return Ok(AxSelectionOfferStatus { enabled: true, permission: "granted" });
        }
        free_context(owned_context);
        return Ok(AxSelectionOfferStatus {
            enabled: false,
            permission: if result == -1 { "denied" } else { "unavailable" },
        });
    }

    let _ = unsafe { noltri_ax_offer_set_enabled(0, std::ptr::null_mut(), on_ax_selection_accepted) };
    if let Some(context) = state.context().take() { free_context(context); }
    Ok(AxSelectionOfferStatus { enabled: false, permission: "not_checked" })
}

#[cfg(test)]
mod tests {
    use super::{valid_ax_request_id, AxSelectionEvent};

    #[test]
    fn accepts_only_synthetic_uuid_ids_and_allowlisted_app_payloads() {
        let event = AxSelectionEvent::Accepted {
            request_id: "ax-123e4567-e89b-12d3-a456-426614174000".into(),
            text: "Synthetic selected text".into(),
            app_name: "TextEdit".into(),
            bundle_id: "com.apple.TextEdit".into(),
        };
        assert!(valid_ax_request_id("ax-123e4567-e89b-12d3-a456-426614174000"));
        assert!(event.is_valid());
        assert!(!valid_ax_request_id("ax-"));
        assert!(!AxSelectionEvent::Accepted {
            request_id: "ax-123e4567-e89b-12d3-a456-426614174000".into(),
            text: "browser selection".into(),
            app_name: "Chrome".into(),
            bundle_id: "com.google.Chrome".into(),
        }.is_valid());
    }
}
