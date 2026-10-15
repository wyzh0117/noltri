use crate::runtime::{CoreRuntimeHandle, CoreStatus};
use crate::settings::{ModelProfile, ModelSettings};
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    api_base_url: String,
    api_token: String,
    mcp_endpoint: String,
    model_profiles: Vec<ModelProfile>,
    active_model_id: Option<String>,
    runtime_status: String,
}

fn runtime_status(handle: &CoreRuntimeHandle) -> String {
    match handle.status() {
        CoreStatus::Starting => "starting",
        CoreStatus::External => "external",
        CoreStatus::DevManual => "dev",
        CoreStatus::Managed => "managed",
        CoreStatus::Failed(_) => "failed",
    }
    .to_owned()
}

#[tauri::command]
pub fn get_settings(app: AppHandle, runtime: State<'_, Arc<CoreRuntimeHandle>>) -> DesktopSettings {
    let config_dir = app
        .path()
        .app_config_dir()
        .ok()
        .map(crate::settings::directory);
    let settings = crate::settings::load(config_dir.as_deref());
    DesktopSettings {
        api_base_url: settings.api_base_url,
        api_token: settings.api_token,
        mcp_endpoint: settings.mcp_endpoint,
        model_profiles: settings.models.model_profiles,
        active_model_id: settings.models.active_model_id,
        runtime_status: runtime_status(&runtime),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveModelsResult {
    applied: bool,
    runtime_status: String,
    message: String,
}

#[tauri::command]
pub async fn save_model_settings(
    app: AppHandle,
    runtime: State<'_, Arc<CoreRuntimeHandle>>,
    mut settings: ModelSettings,
) -> Result<SaveModelsResult, String> {
    settings.validate()?;
    let directory = crate::settings::directory(
        app.path()
            .app_config_dir()
            .map_err(|error| error.to_string())?,
    );
    let handle = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _update = handle.begin_model_update()?;
        crate::settings::save(&directory, &settings)?;
        let applied = crate::runtime::apply_models(app, handle.clone())?;
        let message = if applied { "模型已保存并启用，新收集的内容将由所选模型自动分类。" }
            else { "模型已保存。当前服务由外部进程或开发终端管理；请使用此模型配置重启 Core，应用无法替它更换模型。" };
        Ok(SaveModelsResult { applied, runtime_status: runtime_status(&handle), message: message.to_owned() })
    }).await.map_err(|error| error.to_string())?
}
