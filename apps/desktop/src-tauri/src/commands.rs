use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    api_base_url: String,
    api_token: String,
    mcp_endpoint: String,
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> DesktopSettings {
    let config_dir = app.path().app_config_dir().ok();
    let settings = crate::settings::load(config_dir.as_deref());
    DesktopSettings {
        api_base_url: settings.api_base_url,
        api_token: settings.api_token,
        mcp_endpoint: settings.mcp_endpoint,
    }
}
