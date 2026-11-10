mod capture;
mod ax_selection;
mod commands;
mod device_access;
mod hotkey;
mod instance;
mod processing_console;
mod runtime;
mod settings;
mod shortcut_settings;
mod updates;

use std::sync::Arc;

use tauri::{Manager, RunEvent, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let runtime = Arc::new(runtime::CoreRuntimeHandle::default());
    let runtime_for_setup = runtime.clone();
    let capture_state = Arc::new(capture::CaptureState::default());
    let ax_selection_state = Arc::new(ax_selection::AxSelectionOfferState::default());
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updates::UpdateState::default())
        .manage(processing_console::ConsoleWindowState::default())
        .manage(runtime.clone())
        .manage(capture_state.clone())
        .manage(ax_selection_state.clone())
        .setup(move |app| {
            // The profile lock precedes every key registration and owned child.
            // An explicit different profile is independent; no PID-file guessing.
            let directory = settings::directory(
                app.path()
                    .app_config_dir()
                    .map_err(|_| std::io::Error::other("settings_directory_unavailable"))?,
            );
            match instance::acquire(&directory).map_err(std::io::Error::other)? {
                Some(guard) => {
                    if !app.manage(guard) {
                        return Err(std::io::Error::other("instance_guard_unavailable").into());
                    }
                    eprintln!(
                        "noltri_instance app_pid={} outcome=acquired",
                        std::process::id()
                    );
                }
                None => {
                    eprintln!(
                        "noltri_instance app_pid={} outcome=duplicate_profile",
                        std::process::id()
                    );
                    app.handle().exit(0);
                    return Ok(());
                }
            }
            hotkey::register_global_shortcuts(app.handle().clone());
            runtime::start(app.handle().clone(), runtime_for_setup);
            Ok(())
        })
        .invoke_handler({
            let handler: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
                capture::begin_screen_capture,
                capture::take_screen_capture_bytes,
                capture::snapshot_system_clipboard,
                capture::take_clipboard_snapshot,
                capture::get_intake_shortcut_status,
                hotkey::save_intake_shortcuts,
                runtime::get_runtime_diagnostics,
                capture::trace_capture_stage,
                ax_selection::start_ax_selection_offers_if_enabled,
                ax_selection::get_ax_selection_offer_status,
                ax_selection::set_ax_selection_offers_enabled,
                commands::get_settings,
                commands::save_model_settings,
                commands::use_model,
                commands::fetch_available_models,
                updates::check_native_update,
                updates::download_native_update,
                updates::install_native_update,
                updates::restart_after_native_update,
                processing_console::open_processing_console,
                processing_console::get_native_window_role,
                processing_console::get_processing_console_bootstrap
            ];
            move |invoke: tauri::ipc::Invoke| {
                if !processing_console::command_allowed(
                    invoke.message.webview_ref().label(),
                    invoke.message.command(),
                ) {
                    invoke.resolver.reject("window_command_forbidden");
                    return true;
                }
                handler(invoke)
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build Tauri app");

    let capture_state_for_exit = capture_state.clone();
    let ax_selection_state_for_exit = ax_selection_state.clone();
    app.run(move |_app_handle, event| {
        match event {
            RunEvent::WindowEvent { label, event: WindowEvent::Destroyed, .. } if label == "main" => {
                // The AX observer is app-wide; stop it when its consumer webview disappears.
                ax_selection::stop(ax_selection_state_for_exit.as_ref());
            }
            RunEvent::Exit => {
                ax_selection::stop(ax_selection_state_for_exit.as_ref());
                hotkey::unregister_global_shortcuts();
                capture_state_for_exit.cancel_in_progress_capture();
                let _ = runtime.shutdown();
            }
            _ => {}
        }
    });
}
