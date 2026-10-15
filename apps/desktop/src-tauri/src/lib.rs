mod commands;
mod runtime;
mod settings;

use std::sync::Arc;

use tauri::RunEvent;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let runtime = Arc::new(runtime::CoreRuntimeHandle::default());
    let runtime_for_setup = runtime.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(runtime.clone())
        .setup(move |app| {
            runtime::start(app.handle().clone(), runtime_for_setup);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_model_settings
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Tauri app");

    app.run(move |_app_handle, event| {
        if matches!(event, RunEvent::Exit) {
            runtime.stop();
        }
    });
}
