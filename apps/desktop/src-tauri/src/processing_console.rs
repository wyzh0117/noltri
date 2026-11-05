use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "processing-console";
#[derive(Default)]
pub struct ConsoleWindowState(Mutex<()>);

fn window_role(label: &str) -> Result<&'static str, &'static str> {
    match label {
        "main" => Ok("main"),
        LABEL => Ok(LABEL),
        _ => Err("unsupported_window"),
    }
}
/// Custom application IPC only. Plugin/core permissions remain under Tauri capabilities.
pub fn command_allowed(label: &str, command: &str) -> bool {
    label == "main"
        || (label == LABEL
            && matches!(
                command,
                "get_native_window_role"
                    | "get_processing_console_bootstrap"
                    | "get_runtime_diagnostics"
            ))
}
trait WindowAccess {
    fn exists(&self) -> bool;
    fn create(&mut self) -> Result<(), String>;
    fn reveal(&mut self) -> Result<(), String>;
}
fn open_with(label: &str, windows: &mut impl WindowAccess) -> Result<(), String> {
    if label != "main" {
        return Err("main_window_required".into());
    }
    if !windows.exists() {
        windows.create()?;
    }
    windows.reveal()
}
struct NativeWindows(AppHandle);
impl WindowAccess for NativeWindows {
    fn exists(&self) -> bool {
        self.0.get_webview_window(LABEL).is_some()
    }
    fn create(&mut self) -> Result<(), String> {
        WebviewWindowBuilder::new(&self.0, LABEL, WebviewUrl::App("main.html".into()))
            .title("处理规则与记录 · 知序")
            .inner_size(1180.0, 820.0)
            .min_inner_size(760.0, 560.0)
            .visible(false)
            .build()
            .map_err(|_| "console_window_create_failed".to_owned())?;
        Ok(())
    }
    fn reveal(&mut self) -> Result<(), String> {
        let window = self
            .0
            .get_webview_window(LABEL)
            .ok_or("console_window_missing")?;
        window.show().map_err(|_| "console_window_show_failed")?;
        window
            .set_focus()
            .map_err(|_| "console_window_focus_failed".into())
    }
}
#[tauri::command]
pub async fn open_processing_console(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, ConsoleWindowState>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("main_window_required".into());
    }
    let _opening = state.0.try_lock().map_err(|_| "console_window_busy")?;
    // No await while holding this synchronous guard. The async command avoids macOS IPC-thread creation deadlocks.
    open_with(window.label(), &mut NativeWindows(app))
}
#[tauri::command]
pub fn get_native_window_role(window: WebviewWindow) -> Result<&'static str, String> {
    window_role(window.label()).map_err(str::to_owned)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleBootstrap {
    api_base_url: String,
    api_token: String,
}
fn bootstrap(api_base_url: String, api_token: String) -> Result<ConsoleBootstrap, String> {
    crate::device_access::validate_token(&api_token)?;
    let url = tauri::Url::parse(&api_base_url).map_err(|_| "invalid_console_connection")?;
    let loopback = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if !matches!(url.scheme(), "http" | "https")
        || !loopback
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || api_token.trim().is_empty()
    {
        return Err("authenticated_local_core_required".into());
    }
    Ok(ConsoleBootstrap {
        api_base_url,
        api_token,
    })
}
#[tauri::command]
pub async fn get_processing_console_bootstrap(
    window: WebviewWindow,
    runtime: State<'_, std::sync::Arc<crate::runtime::CoreRuntimeHandle>>,
) -> Result<ConsoleBootstrap, String> {
    if window.label() != LABEL {
        return Err("console_window_required".into());
    }
    let handle = runtime.inner().clone();
    let connection = tauri::async_runtime::spawn_blocking(move || handle.wait_connection())
        .await
        .map_err(|_| "authenticated_runtime_not_ready")??;
    bootstrap(connection.api_base_url, connection.api_token)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[derive(Default)]
    struct FakeWindow {
        exists: bool,
        creates: usize,
        reveals: usize,
    }
    impl WindowAccess for FakeWindow {
        fn exists(&self) -> bool {
            self.exists
        }
        fn create(&mut self) -> Result<(), String> {
            self.exists = true;
            self.creates += 1;
            Ok(())
        }
        fn reveal(&mut self) -> Result<(), String> {
            self.reveals += 1;
            Ok(())
        }
    }
    #[test]
    fn real_labels_determine_role() {
        assert_eq!(window_role("processing-console"), Ok("processing-console"));
        assert_eq!(window_role("main"), Ok("main"));
        assert!(window_role("main?role=processing-console").is_err());
    }
    #[test]
    fn console_has_only_minimal_bootstrap_ipc() {
        assert!(command_allowed(LABEL, "get_processing_console_bootstrap"));
        assert!(command_allowed(LABEL, "get_native_window_role"));
        assert!(command_allowed(LABEL, "get_runtime_diagnostics"));
        for c in [
            "get_settings",
            "save_model_settings",
            "use_model",
            "fetch_available_models",
            "begin_screen_capture",
            "check_native_update",
            "download_native_update",
            "install_native_update",
            "restart_after_native_update",
            "open_processing_console",
            "save_intake_shortcuts",
        ] {
            assert!(!command_allowed(LABEL, c));
        }
        assert!(!command_allowed("unknown", "get_native_window_role"));
        assert!(!command_allowed("unknown", "get_runtime_diagnostics"));
        assert!(command_allowed("main", "open_processing_console"));
    }
    #[test]
    fn repeated_open_reuses_without_recreating() {
        let mut w = FakeWindow::default();
        open_with("main", &mut w).unwrap();
        open_with("main", &mut w).unwrap();
        assert_eq!(w.creates, 1);
        assert_eq!(w.reveals, 2);
    }
    #[test]
    fn unauthorized_open_has_no_window_side_effect() {
        let mut w = FakeWindow::default();
        assert!(open_with(LABEL, &mut w).is_err());
        assert_eq!(w.creates, 0);
        assert_eq!(w.reveals, 0);
    }
    #[test]
    fn bootstrap_exposes_only_authenticated_local_connection() {
        let b = bootstrap("http://127.0.0.1:8787".into(), "synthetic-token".into()).unwrap();
        assert_eq!(
            serde_json::to_value(b).unwrap(),
            serde_json::json!({"apiBaseUrl":"http://127.0.0.1:8787","apiToken":"synthetic-token"})
        );
        for url in [
            "https://example.com",
            "http://127.0.0.1.evil.test",
            "file:///tmp/test",
            "http://user@localhost",
        ] {
            assert!(bootstrap(url.into(), "synthetic-token".into()).is_err());
        }
        assert!(bootstrap("http://localhost:8787".into(), "".into()).is_err());
        assert!(bootstrap(
            "http://localhost:18887".into(),
            "bad\r\nHeader:value".into()
        )
        .is_err());
    }
    #[test]
    fn overlapping_open_is_rejected() {
        let s = ConsoleWindowState::default();
        let g = s.0.try_lock().unwrap();
        assert!(s.0.try_lock().is_err());
        drop(g);
        assert!(s.0.try_lock().is_ok());
    }
}
