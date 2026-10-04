//! Full-size application windows that are not floating overlays: 知识工作台 and the Setup Manager.
//!
//! Both follow the pattern the paste window proved — build once during setup while hidden, then show and
//! focus on demand. Creating a webview inside a synchronous command is the path that can hang.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const WORKBENCH_LABEL: &str = "workbench";
pub const MAIN_LABEL: &str = "main";

/// 1280×820 so the §17.1 three-column layout (rail · tree ≥55% · detail) never has to collapse.
pub fn create_workbench(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(WORKBENCH_LABEL).is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, WORKBENCH_LABEL, WebviewUrl::App("workbench.html".into()))
        .title("知序 · 知识工作台")
        .inner_size(1280.0, 820.0)
        .min_inner_size(940.0, 600.0)
        .center()
        .visible(false)
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn raise(app: &AppHandle, label: &str) -> Result<(), String> {
    let Some(window) = app.get_webview_window(label) else {
        return Err(format!("{label} 窗口不存在 / window not available"));
    };
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

pub fn open_workbench(app: &AppHandle) -> Result<(), String> {
    raise(app, WORKBENCH_LABEL)
}

/// The Setup Manager owns the settings this window only reads, so raising it is the way to change them.
pub fn open_setup_manager(app: &AppHandle) -> Result<(), String> {
    raise(app, MAIN_LABEL)
}
