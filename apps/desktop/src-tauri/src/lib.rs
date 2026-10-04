//! 知序 Companion — application wiring.
//!
//! Responsibilities of this module, in the order they matter:
//! 1. Own the single [`SharedState`] that both the observer thread and the IPC commands read.
//! 2. Start the polling observer and the global shortcut. Each of those may legitimately fail
//!    (no Accessibility permission, the shortcut is taken by another app) without taking the Setup
//!    Manager down with it — a broken capture rung must never hide the diagnostics that explain it.
//! 3. Keep the floating windows and the 知识工作台 alive for the whole session (created once,
//!    shown/hidden) and track overlay focus, so the observer never reads the pill's own text field.

mod commands;
mod mcp;
mod overlay;
mod settings;
mod state;
mod time;
mod windows;

pub mod accessibility;

use std::sync::{Arc, Mutex, MutexGuard};

use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use crate::accessibility::observer::{self, Observer};
use crate::overlay::{PASTE_LABEL, OVERLAY_LABEL};
use crate::state::RuntimeState;
use crate::windows::WORKBENCH_LABEL;

/// The observer thread and every command share one lock. Poisoning is recovered rather than
/// propagated: a panic inside the AX layer must not stop the Setup Manager from answering.
#[derive(Clone, Default)]
pub struct SharedState(Arc<Inner>);

#[derive(Default)]
struct Inner {
    state: Mutex<RuntimeState>,
}

impl SharedState {
    pub fn new(state: RuntimeState) -> Self {
        Self(Arc::new(Inner {
            state: Mutex::new(state),
        }))
    }

    pub fn lock(&self) -> MutexGuard<'_, RuntimeState> {
        self.0
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Registers (or re-registers) the configured accelerator. Errors are returned so `set_settings`
/// can show them; at startup the caller only logs, because a shortcut taken by another app still
/// leaves the observer and the paste fallback working.
pub(crate) fn register_shortcut(app: &AppHandle) -> Result<String, String> {
    let shortcut = {
        let Some(state) = app.try_state::<SharedState>() else {
            return Err("状态尚未初始化".to_string());
        };
        let configured = state.lock().settings.global_shortcut.clone();
        configured
    };
    let manager = app.global_shortcut();
    if manager.is_registered(shortcut.as_str()) {
        return Ok(shortcut);
    }
    // Unregister first: changing the accelerator must not leave the old combination stealing keys.
    let _ = manager.unregister_all();
    manager
        .register(shortcut.as_str())
        .map_err(|error| format!("注册全局快捷键 {shortcut} 失败：{error}"))?;
    Ok(shortcut)
}

fn is_companion_window(label: &str) -> bool {
    label == OVERLAY_LABEL || label == PASTE_LABEL
}

/// True when `fired` is the accelerator the user currently has configured. Comparing parsed
/// shortcuts (not strings) means `cmd+shift+k` and `Cmd+Shift+K` are the same trigger.
fn is_configured_shortcut(app: &AppHandle, fired: &tauri_plugin_global_shortcut::Shortcut) -> bool {
    let Some(state) = app.try_state::<SharedState>() else {
        return false;
    };
    let configured = state.lock().settings.global_shortcut.clone();
    match configured.parse::<tauri_plugin_global_shortcut::Shortcut>() {
        Ok(parsed) => parsed.id() == fired.id(),
        // An accelerator the parser rejects cannot have been registered by us.
        Err(_) => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let observer = Arc::new(Observer::default());
    let observer_for_exit = observer.clone();

    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed && is_configured_shortcut(app, shortcut) {
                        observer::shortcut_capture(app, &app.state::<SharedState>());
                    }
                })
                .build(),
        )
        .manage(observer.clone())
        .setup(move |app| {
            let handle = app.handle().clone();
            let config_dir = app
                .path()
                .app_config_dir()
                .map_err(|error| format!("无法解析配置目录：{error}"))?;
            let (loaded, warning) = settings::load(&config_dir);
            let mut initial = RuntimeState::default();
            initial.settings = loaded;
            initial.config_dir = Some(config_dir);
            initial.settings_warning = warning;
            let capture_enabled = initial.settings.capture_enabled;
            let shared = SharedState::new(initial);
            app.manage(shared.clone());

            if capture_enabled {
                match observer.start(handle.clone(), shared.clone()) {
                    Ok(()) => shared.lock().running = true,
                    Err(error) => {
                        eprintln!("[noltri] 选区观察线程启动失败: {error}");
                        let mut guard = shared.lock();
                        guard.status = state::ObserverStatus::ReadFailed {
                            app: "本机".to_string(),
                            reason: error,
                        };
                    }
                }
            } else {
                shared.lock().status = state::ObserverStatus::Disabled;
            }

            match register_shortcut(&handle) {
                Ok(shortcut) => eprintln!("[noltri] 全局快捷键已注册: {shortcut}"),
                Err(error) => eprintln!("[noltri] {error}（浮层按钮与粘贴窗口仍然可用）"),
            }

            // Built once, hidden: the paste window is the last fallback and must not pay for
            // window creation at the moment the user needs it.
            if let Err(error) = overlay::create_paste_window(&handle) {
                eprintln!("[noltri] 粘贴窗口创建失败: {error}");
            }
            if let Err(error) = windows::create_workbench(&handle) {
                eprintln!("[noltri] 知识工作台窗口创建失败: {error}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == WORKBENCH_LABEL {
                // Closing the workbench puts it away rather than destroying it: `open_workbench` can only
                // show a window that still exists, so a closed workbench must stay reopenable.
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
                return;
            }
            if !is_companion_window(window.label()) {
                return;
            }
            match event {
                tauri::WindowEvent::Focused(focused) => {
                    if let Some(state) = window.try_state::<SharedState>() {
                        state.lock().set_window_focus(window.label(), *focused);
                    }
                }
                // Closing the pill must not quit the companion; it only puts it away.
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                    if let Some(state) = window.try_state::<SharedState>() {
                        state.lock().set_window_focus(window.label(), false);
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::capture_state,
            commands::get_selection_preview,
            commands::test_selection_capture,
            commands::recheck_permission,
            commands::open_accessibility_settings,
            commands::hide_window,
            commands::open_paste_window,
            commands::open_workbench_window,
            commands::open_setup_manager,
            commands::paste_selection,
            commands::set_capture_enabled,
            commands::get_settings,
            commands::set_settings,
            commands::set_app_opt_out,
            commands::list_incompatible_apps,
            commands::clear_incompatible_app,
            commands::mcp_config_for,
            commands::test_connection,
            commands::read_config_file,
            commands::write_mcp_config,
            commands::open_connection_url,
            commands::open_documentation,
            commands::record_capture_outcome,
            commands::dismiss_overlay,
            commands::runtime_info,
        ]);

    match builder.build(tauri::generate_context!()) {
        Ok(app) => app.run(move |_app_handle, event| {
            if matches!(event, RunEvent::Exit) {
                observer_for_exit.stop();
            }
        }),
        // A failure here is a broken config or a missing frontend bundle. Say what and why on
        // stderr instead of panicking, so a user can fix it without a crash report.
        Err(error) => {
            eprintln!("[noltri] 应用初始化失败: {error}");
            eprintln!("[noltri] 请检查 src-tauri/tauri.conf.json 与前端构建产物 ../dist 是否存在");
        }
    }
}
