use crate::runtime::{CoreRuntimeHandle, CoreStatus};
use crate::settings::{
    ModelSettings, ProviderDraft, ProviderModel, ProviderProtocol, ProviderView,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    api_base_url: String,
    api_token: String,
    mcp_endpoint: String,
    providers: Vec<ProviderView>,
    active_provider_id: Option<String>,
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
        providers: settings
            .models
            .providers
            .iter()
            .map(ProviderView::from)
            .collect(),
        active_provider_id: settings.models.active_provider_id,
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveModelsInput {
    providers: Vec<ProviderDraft>,
    #[serde(default)]
    clear_active: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UseModelInput {
    providers: Vec<ProviderDraft>,
    provider_id: String,
    model_id: String,
}

fn config_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(crate::settings::directory(
        app.path()
            .app_config_dir()
            .map_err(|error| error.to_string())?,
    ))
}

fn wait_for_managed_runtime(handle: &CoreRuntimeHandle) -> Result<(), String> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while handle.status() == CoreStatus::Starting && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    match handle.status() {
        CoreStatus::Managed => Ok(()),
        CoreStatus::Starting => Err("Core 启动超时，暂时无法应用模型设置。".to_owned()),
        CoreStatus::External | CoreStatus::DevManual => Err(
            "当前 Core 由外部进程管理，无法应用模型设置；请先停止外部 Core 并重启本应用。"
                .to_owned(),
        ),
        CoreStatus::Failed(reason) => Err(format!("Core 未就绪，无法应用模型：{reason}")),
    }
}

async fn require_managed_runtime(handle: Arc<CoreRuntimeHandle>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || wait_for_managed_runtime(&handle))
        .await
        .map_err(|error| error.to_string())?
}

async fn persist_and_apply(
    app: AppHandle,
    handle: Arc<CoreRuntimeHandle>,
    directory: std::path::PathBuf,
    models: ModelSettings,
    message: &'static str,
) -> Result<SaveModelsResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _update = handle.begin_model_update()?;
        crate::settings::save(&directory, &models)?;
        let applied = crate::runtime::apply_models(app, handle.clone())?;
        let final_message = if applied {
            message.to_owned()
        } else {
            format!("{message} 当前 Core 由外部进程或开发终端管理，运行中的服务未切换。")
        };
        Ok(SaveModelsResult {
            applied,
            runtime_status: runtime_status(&handle),
            message: final_message,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn save_model_settings(
    app: AppHandle,
    runtime: State<'_, Arc<CoreRuntimeHandle>>,
    settings: SaveModelsInput,
) -> Result<SaveModelsResult, String> {
    let directory = config_dir(&app)?;
    let current = crate::settings::load(Some(&directory)).models;
    let next = crate::settings::apply_drafts(&current, settings.providers, settings.clear_active)?;
    if settings.clear_active && current.active().is_some() {
        require_managed_runtime(runtime.inner().clone()).await?;
    }
    let handle = runtime.inner().clone();
    persist_and_apply(
        app,
        handle,
        directory,
        next,
        if settings.clear_active {
            "已清空当前模型，AI 操作已停用。"
        } else {
            "Provider 设置已保存；当前模型选择保持不变。"
        },
    )
    .await
}

#[tauri::command]
pub async fn use_model(
    app: AppHandle,
    runtime: State<'_, Arc<CoreRuntimeHandle>>,
    settings: UseModelInput,
) -> Result<SaveModelsResult, String> {
    require_managed_runtime(runtime.inner().clone()).await?;
    let directory = config_dir(&app)?;
    let current = crate::settings::load(Some(&directory)).models;
    let mut next = crate::settings::apply_drafts(&current, settings.providers, true)?;
    if !next.providers.iter().any(|provider| {
        provider.id == settings.provider_id
            && provider
                .models
                .iter()
                .any(|model| model.id == settings.model_id && model.input.text)
    }) {
        return Err("所选 Provider/Model 不存在或不支持文本输入。".to_owned());
    }
    next.active_provider_id = Some(settings.provider_id);
    next.active_model_id = Some(settings.model_id);
    next.validate()?;
    persist_and_apply(
        app,
        runtime.inner().clone(),
        directory,
        next,
        "已保存并启用所选模型。",
    )
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchAvailableModelsInput {
    provider_id: Option<String>,
    protocol: ProviderProtocol,
    base_url: String,
    api_key: Option<String>,
}

fn validated_base_url(value: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(value.trim()).map_err(|_| "API 地址格式无效。".to_owned())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("API 地址应为 http(s) Base URL，不包含账号、查询参数或片段。".to_owned());
    }
    Ok(url)
}

fn models_url(base: &tauri::Url, protocol: ProviderProtocol) -> Result<tauri::Url, String> {
    let mut url = base.clone();
    let path = base.path().trim_end_matches('/');
    let path = match protocol {
        ProviderProtocol::AnthropicMessages if path.ends_with("/v1") => format!("{path}/models"),
        ProviderProtocol::AnthropicMessages => format!("{path}/v1/models"),
        _ => format!("{path}/models"),
    };
    url.set_path(&path);
    Ok(url)
}

fn set_page_cursor(url: &mut tauri::Url, cursor: &str) {
    url.set_query(None);
    url.query_pairs_mut().append_pair("after_id", cursor);
}

fn parse_model_list(
    value: &serde_json::Value,
) -> Result<(Vec<ProviderModel>, bool, Option<String>), String> {
    let entries = value
        .get("data")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "模型服务返回的数据格式无效。".to_owned())?;
    let models = entries
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id")?.as_str()?.trim();
            if id.is_empty() {
                return None;
            }
            let name = entry
                .get("display_name")
                .and_then(serde_json::Value::as_str)
                .or_else(|| entry.get("name").and_then(serde_json::Value::as_str))
                .unwrap_or(id);
            Some(ProviderModel {
                id: id.to_owned(),
                name: name.to_owned(),
                context_window: entry
                    .get("context_window")
                    .and_then(serde_json::Value::as_u64),
                max_tokens: entry.get("max_tokens").and_then(serde_json::Value::as_u64),
                input: crate::settings::ModelInputTypes {
                    text: true,
                    image: false,
                },
            })
        })
        .collect();
    Ok((
        models,
        value
            .get("has_more")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        value
            .get("last_id")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
    ))
}

#[tauri::command]
pub async fn fetch_available_models(
    app: AppHandle,
    input: FetchAvailableModelsInput,
) -> Result<Vec<ProviderModel>, String> {
    let base = validated_base_url(&input.base_url)?;
    let saved = input.provider_id.as_ref().and_then(|provider_id| {
        let directory = app
            .path()
            .app_config_dir()
            .ok()
            .map(crate::settings::directory)?;
        let settings = crate::settings::load(Some(&directory)).models;
        settings.providers.into_iter().find(|provider| {
            provider.id == *provider_id
                && provider.protocol == input.protocol
                && provider.base_url.trim_end_matches('/')
                    == input.base_url.trim().trim_end_matches('/')
        })
    });
    let api_key = input
        .api_key
        .as_deref()
        .filter(|key| !key.trim().is_empty())
        .map(str::trim)
        .or_else(|| {
            saved
                .as_ref()
                .map(|provider| provider.api_key.as_str())
                .filter(|key| !key.is_empty())
        });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|_| "无法初始化模型服务请求。".to_owned())?;
    let mut url = models_url(&base, input.protocol)?;
    let mut all = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for _ in 0..100 {
        let mut request = client
            .get(url.clone())
            .header(reqwest::header::ACCEPT, "application/json");
        match input.protocol {
            ProviderProtocol::AnthropicMessages => {
                request = request.header("anthropic-version", "2023-06-01");
                if let Some(key) = api_key {
                    request = request.header("x-api-key", key);
                }
            }
            _ => {
                if let Some(key) = api_key {
                    request = request.bearer_auth(key);
                }
            }
        }
        let response = request.send().await.map_err(|error| {
            if error.is_timeout() {
                "获取模型列表超时，请检查服务地址后重试。".to_owned()
            } else {
                "无法连接模型服务，请检查服务地址和网络。".to_owned()
            }
        })?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err("模型服务鉴权失败，请检查 API Key。".to_owned());
        }
        if !status.is_success() {
            return Err(format!(
                "获取模型列表失败，服务端返回 HTTP {}。",
                status.as_u16()
            ));
        }
        let value: serde_json::Value = response
            .json()
            .await
            .map_err(|_| "模型服务返回的 JSON 无法解析。".to_owned())?;
        let (models, has_more, last_id) = parse_model_list(&value)?;
        for model in models {
            if seen.insert(model.id.clone()) {
                all.push(model);
            }
        }
        if input.protocol != ProviderProtocol::AnthropicMessages || !has_more {
            return Ok(all);
        }
        let after_id = last_id
            .or_else(|| all.last().map(|model| model.id.clone()))
            .ok_or_else(|| "模型服务分页结果缺少继续查询标识。".to_owned())?;
        set_page_cursor(&mut url, &after_id);
    }
    Err("模型服务返回的分页过多，已停止获取。".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_pagination_replaces_the_previous_cursor() {
        let mut url = tauri::Url::parse("https://api.anthropic.com/v1/models").unwrap();
        set_page_cursor(&mut url, "first-page");
        set_page_cursor(&mut url, "second-page");
        assert_eq!(
            url.query_pairs().collect::<Vec<_>>(),
            vec![("after_id".into(), "second-page".into())]
        );
    }
}
