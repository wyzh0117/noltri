use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProviderProtocol {
    #[serde(rename = "openai-completions")]
    OpenAiCompletions,
    #[serde(rename = "openai-responses")]
    OpenAiResponses,
    #[serde(rename = "anthropic-messages")]
    AnthropicMessages,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInputTypes {
    pub text: bool,
    pub image: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub id: String,
    pub name: String,
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
    pub input: ModelInputTypes,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub protocol: ProviderProtocol,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub models: Vec<ProviderModel>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub id: String,
    pub name: String,
    pub protocol: ProviderProtocol,
    pub base_url: String,
    pub has_api_key: bool,
    pub models: Vec<ProviderModel>,
}

impl From<&ProviderConfig> for ProviderView {
    fn from(provider: &ProviderConfig) -> Self {
        Self {
            id: provider.id.clone(),
            name: provider.name.clone(),
            protocol: provider.protocol,
            base_url: provider.base_url.clone(),
            has_api_key: !provider.api_key.is_empty(),
            models: provider.models.clone(),
        }
    }
}

/// Write-only API key field. Empty/omitted retains a saved key unless clear_api_key is true.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDraft {
    pub id: String,
    pub name: String,
    pub protocol: ProviderProtocol,
    pub base_url: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub clear_api_key: bool,
    #[serde(default)]
    pub models: Vec<ProviderModel>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSettings {
    #[serde(default)]
    pub providers: Vec<ProviderConfig>,
    #[serde(default)]
    pub active_provider_id: Option<String>,
    #[serde(default)]
    pub active_model_id: Option<String>,
}

pub struct DesktopSettings {
    pub api_base_url: String,
    pub api_token: String,
    pub mcp_endpoint: String,
    pub models: ModelSettings,
}

pub fn directory(default: PathBuf) -> PathBuf {
    std::env::var_os("NOLTRI_SETTINGS_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or(default)
}

fn setting(value: Option<&serde_json::Value>, key: &str, env: &str, fallback: &str) -> String {
    value
        .and_then(|value| value.get(key))
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| {
            std::env::var(env)
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| fallback.to_owned())
}

fn is_local_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host == "::1"
        || host.starts_with("fc")
        || host.starts_with("fd")
        || host.starts_with("fe80:")
    {
        return true;
    }
    let octets = host
        .split('.')
        .map(str::parse::<u8>)
        .collect::<Result<Vec<_>, _>>();
    let Ok([a, b, _, _]) = octets.as_deref() else {
        return false;
    };
    *a == 10
        || *a == 127
        || (*a == 192 && *b == 168)
        || (*a == 172 && (16..=31).contains(b))
        || (*a == 169 && *b == 254)
}

fn default_connection_urls(ports: crate::runtime::RuntimePorts) -> (String, String) {
    (
        format!("http://127.0.0.1:{}", ports.core),
        format!("http://127.0.0.1:{}/mcp", ports.mcp),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyProfile {
    id: String,
    name: String,
    provider: String,
    base_url: String,
    api_key: String,
    model: String,
}

fn migrate_legacy(value: &serde_json::Value) -> ModelSettings {
    let profiles = value
        .get("modelProfiles")
        .and_then(|profiles| serde_json::from_value::<Vec<LegacyProfile>>(profiles.clone()).ok())
        .unwrap_or_default();
    let active_legacy = value
        .get("activeModelId")
        .and_then(serde_json::Value::as_str);
    let mut models = ModelSettings::default();
    let mut active_pair = None;
    for profile in profiles {
        let base_url = profile.base_url.trim().trim_end_matches('/').to_owned();
        let Some(provider) = models
            .providers
            .iter_mut()
            .find(|provider| provider.base_url == base_url && provider.api_key == profile.api_key)
        else {
            let provider_id = format!("legacy-{}-{}", profile.provider, profile.id);
            models.providers.push(ProviderConfig {
                id: provider_id,
                name: profile.provider.clone(),
                protocol: ProviderProtocol::OpenAiCompletions,
                base_url,
                api_key: profile.api_key.clone(),
                models: Vec::new(),
            });
            let provider = models.providers.last_mut().expect("just inserted provider");
            if Some(profile.id.as_str()) == active_legacy {
                active_pair = Some((provider.id.clone(), profile.model.clone()));
            }
            provider.models.push(ProviderModel {
                id: profile.model,
                name: profile.name,
                context_window: None,
                max_tokens: None,
                input: ModelInputTypes {
                    text: true,
                    image: false,
                },
            });
            continue;
        };
        if Some(profile.id.as_str()) == active_legacy {
            active_pair = Some((provider.id.clone(), profile.model.clone()));
        }
        if !provider
            .models
            .iter()
            .any(|model| model.id == profile.model)
        {
            provider.models.push(ProviderModel {
                id: profile.model,
                name: profile.name,
                context_window: None,
                max_tokens: None,
                input: ModelInputTypes {
                    text: true,
                    image: false,
                },
            });
        }
    }
    if let Some((provider_id, model_id)) = active_pair {
        models.active_provider_id = Some(provider_id);
        models.active_model_id = Some(model_id);
    }
    models
}

pub fn load(config_dir: Option<&Path>) -> DesktopSettings {
    let value = config_dir
        .and_then(|dir| std::fs::read(dir.join("settings.json")).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let models = value
        .as_ref()
        .and_then(|value| value.get("providers").map(|_| value))
        .and_then(|value| serde_json::from_value::<ModelSettings>(value.clone()).ok())
        .or_else(|| value.as_ref().map(migrate_legacy))
        .unwrap_or_default();
    let ports = crate::runtime::resolve_runtime_ports().unwrap_or_default();
    let (default_api_base_url, default_mcp_endpoint) = default_connection_urls(ports);
    DesktopSettings {
        api_base_url: setting(
            value.as_ref(),
            "apiBaseUrl",
            "NOLTRI_API_BASE_URL",
            &default_api_base_url,
        ),
        api_token: setting(value.as_ref(), "apiToken", "NOLTRI_ACCESS_TOKEN", ""),
        mcp_endpoint: setting(
            value.as_ref(),
            "mcpEndpoint",
            "NOLTRI_MCP_ENDPOINT",
            &default_mcp_endpoint,
        ),
        models,
    }
}

impl ModelSettings {
    pub fn validate(&mut self) -> Result<(), String> {
        if self.providers.len() > 40 {
            return Err("最多可保存 40 个 Provider。".to_owned());
        }
        let mut provider_ids = HashSet::new();
        for provider in &mut self.providers {
            provider.id = provider.id.trim().to_owned();
            provider.name = provider.name.trim().to_owned();
            provider.base_url = provider.base_url.trim().trim_end_matches('/').to_owned();
            provider.api_key = provider.api_key.trim().to_owned();
            if provider.id.is_empty() || !provider_ids.insert(provider.id.clone()) {
                return Err("Provider 标识不能为空或重复。".to_owned());
            }
            if provider.id.len() > 200
                || provider.name.len() > 400
                || provider.base_url.len() > 8000
                || provider.api_key.len() > 8000
            {
                return Err("Provider 字段过长，请检查输入。".to_owned());
            }
            if provider.name.is_empty() {
                return Err("请填写 Provider 名称。".to_owned());
            }
            let url = tauri::Url::parse(&provider.base_url).map_err(|_| "API 地址格式无效。")?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(
                    "API 地址应为 http(s) Base URL，不包含账号、查询参数或片段。".to_owned(),
                );
            }
            if provider.api_key.is_empty() && !is_local_host(url.host_str().unwrap_or_default()) {
                return Err("远程模型服务需要 API Key；本地或内网服务可以留空。".to_owned());
            }
            let path = url.path().trim_end_matches('/');
            if path.ends_with("/chat/completions")
                || path.ends_with("/responses")
                || path.ends_with("/messages")
                || path.ends_with("/models")
            {
                return Err("请填写 API Base URL，不要包含具体 API 路径。".to_owned());
            }
            let mut model_ids = HashSet::new();
            for model in &mut provider.models {
                model.id = model.id.trim().to_owned();
                model.name = model.name.trim().to_owned();
                if model.id.is_empty() || !model_ids.insert(model.id.clone()) {
                    return Err("Model ID 不能为空或重复。".to_owned());
                }
                if model.id.len() > 800 || model.name.len() > 800 {
                    return Err("模型字段过长，请检查输入。".to_owned());
                }
                if !model.input.text && !model.input.image {
                    return Err("模型至少要支持一种输入类型。".to_owned());
                }
                if model.context_window == Some(0)
                    || model.max_tokens == Some(0)
                    || model
                        .context_window
                        .is_some_and(|value| value > 1_000_000_000)
                    || model.max_tokens.is_some_and(|value| value > 1_000_000_000)
                    || model
                        .context_window
                        .zip(model.max_tokens)
                        .is_some_and(|(context, output)| output > context)
                {
                    return Err(
                        "模型上下文窗口和输出上限必须为正数，且输出上限不能超过上下文窗口。"
                            .to_owned(),
                    );
                }
            }
        }
        match (&self.active_provider_id, &self.active_model_id) {
            (None, None) => Ok(()),
            (Some(provider_id), Some(model_id)) => {
                let model = self
                    .providers
                    .iter()
                    .find(|provider| &provider.id == provider_id)
                    .and_then(|provider| {
                        provider.models.iter().find(|model| &model.id == model_id)
                    });
                match model {
                    Some(model) if model.input.text => Ok(()),
                    Some(_) => Err("当前模型必须支持文本输入。".to_owned()),
                    None => Err("当前 Provider 和模型必须同时存在。".to_owned()),
                }
            }
            _ => Err("当前 Provider 和模型必须同时选择或同时清空。".to_owned()),
        }
    }

    pub fn active(&self) -> Option<(&ProviderConfig, &ProviderModel)> {
        let provider_id = self.active_provider_id.as_ref()?;
        let model_id = self.active_model_id.as_ref()?;
        let provider = self
            .providers
            .iter()
            .find(|provider| &provider.id == provider_id)?;
        let model = provider.models.iter().find(|model| &model.id == model_id)?;
        Some((provider, model))
    }
}

pub fn apply_drafts(
    current: &ModelSettings,
    drafts: Vec<ProviderDraft>,
    clear_active: bool,
) -> Result<ModelSettings, String> {
    let mut providers = Vec::with_capacity(drafts.len());
    for draft in drafts {
        let existing = current
            .providers
            .iter()
            .find(|provider| provider.id == draft.id);
        let api_key = if draft.clear_api_key {
            String::new()
        } else if let Some(key) = draft.api_key.filter(|key| !key.trim().is_empty()) {
            key.trim().to_owned()
        } else {
            existing
                .map(|provider| provider.api_key.clone())
                .unwrap_or_default()
        };
        providers.push(ProviderConfig {
            id: draft.id,
            name: draft.name,
            protocol: draft.protocol,
            base_url: draft.base_url,
            api_key,
            models: draft.models,
        });
    }
    let mut next = ModelSettings {
        providers,
        active_provider_id: if clear_active {
            None
        } else {
            current.active_provider_id.clone()
        },
        active_model_id: if clear_active {
            None
        } else {
            current.active_model_id.clone()
        },
    };
    next.validate()?;
    Ok(next)
}

pub fn save(config_dir: &Path, models: &ModelSettings) -> Result<(), String> {
    std::fs::create_dir_all(config_dir).map_err(|error| format!("无法创建设置目录：{error}"))?;
    let file = config_dir.join("settings.json");
    let mut value = match std::fs::read(&file) {
        Ok(bytes) => serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(&bytes)
            .map_err(|error| format!("现有设置无法读取，未覆盖原文件：{error}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => serde_json::Map::new(),
        Err(error) => return Err(format!("无法读取设置：{error}")),
    };
    value.remove("modelProfiles");
    value.remove("activeModelId");
    value.insert(
        "providers".to_owned(),
        serde_json::to_value(&models.providers).map_err(|error| error.to_string())?,
    );
    value.insert(
        "activeProviderId".to_owned(),
        serde_json::to_value(&models.active_provider_id).map_err(|error| error.to_string())?,
    );
    value.insert(
        "activeModelId".to_owned(),
        serde_json::to_value(&models.active_model_id).map_err(|error| error.to_string())?,
    );
    let bytes = serde_json::to_vec_pretty(&value).map_err(|error| error.to_string())?;
    let temporary = config_dir.join("settings.json.tmp");
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut output = options
        .open(&temporary)
        .map_err(|error| format!("无法写入设置：{error}"))?;
    output
        .write_all(&bytes)
        .and_then(|_| output.sync_all())
        .map_err(|error| format!("无法保存设置：{error}"))?;
    std::fs::rename(&temporary, &file).map_err(|error| format!("无法替换设置文件：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(id: &str) -> ProviderModel {
        ProviderModel {
            id: id.into(),
            name: id.into(),
            context_window: None,
            max_tokens: None,
            input: ModelInputTypes {
                text: true,
                image: false,
            },
        }
    }

    #[test]
    fn default_connection_urls_follow_runtime_ports() {
        assert_eq!(
            default_connection_urls(crate::runtime::RuntimePorts {
                core: 18787,
                mcp: 18790,
            }),
            (
                "http://127.0.0.1:18787".to_owned(),
                "http://127.0.0.1:18790/mcp".to_owned(),
            )
        );
    }

    #[test]
    fn legacy_profiles_migrate_without_losing_active_selection_or_key() {
        let value: serde_json::Value = serde_json::from_str(r#"{"modelProfiles":[{"id":"one","name":"DeepSeek","provider":"deepseek","baseUrl":"https://api.deepseek.com/","apiKey":"secret","model":"deepseek-chat"}],"activeModelId":"one"}"#).unwrap();
        let settings = migrate_legacy(&value);
        let (provider, model) = settings.active().unwrap();
        assert_eq!(provider.api_key, "secret");
        assert_eq!(provider.base_url, "https://api.deepseek.com");
        assert_eq!(model.id, "deepseek-chat");
    }

    #[test]
    fn legacy_duplicate_model_ids_collapse_and_active_profile_maps_to_the_model() {
        let value: serde_json::Value = serde_json::json!({
            "modelProfiles": [
                { "id": "first", "name": "Primary", "provider": "deepseek", "baseUrl": "https://api.deepseek.com", "apiKey": "secret", "model": "deepseek-chat" },
                { "id": "second", "name": "Alias", "provider": "deepseek", "baseUrl": "https://api.deepseek.com/", "apiKey": "secret", "model": "deepseek-chat" }
            ],
            "activeModelId": "second"
        });
        let settings = migrate_legacy(&value);
        assert_eq!(settings.providers[0].models.len(), 1);
        assert_eq!(settings.active().unwrap().1.id, "deepseek-chat");
    }

    #[test]
    fn blank_key_retains_saved_key_and_view_redacts_it() {
        let current = ModelSettings {
            providers: vec![ProviderConfig {
                id: "p".into(),
                name: "P".into(),
                protocol: ProviderProtocol::OpenAiCompletions,
                base_url: "https://example.com/v1".into(),
                api_key: "secret".into(),
                models: vec![model("m")],
            }],
            active_provider_id: Some("p".into()),
            active_model_id: Some("m".into()),
        };
        let next = apply_drafts(
            &current,
            vec![ProviderDraft {
                id: "p".into(),
                name: "P".into(),
                protocol: ProviderProtocol::OpenAiCompletions,
                base_url: "https://example.com/v1".into(),
                api_key: Some(String::new()),
                clear_api_key: false,
                models: vec![model("m")],
            }],
            false,
        )
        .unwrap();
        assert_eq!(next.providers[0].api_key, "secret");
        let view = ProviderView::from(&next.providers[0]);
        let serialized = serde_json::to_string(&view).unwrap();
        assert!(!serialized.contains("secret"));
        assert!(view.has_api_key);
    }

    #[test]
    fn keyless_local_provider_is_allowed_but_remote_provider_is_rejected() {
        let mut local = ModelSettings {
            providers: vec![ProviderConfig {
                id: "local".into(),
                name: "Local".into(),
                protocol: ProviderProtocol::OpenAiCompletions,
                base_url: "http://127.0.0.1:11434/v1".into(),
                api_key: String::new(),
                models: vec![model("local-model")],
            }],
            active_provider_id: None,
            active_model_id: None,
        };
        assert!(local.validate().is_ok());
        local.providers[0].base_url = "https://api.example.com/v1".into();
        assert!(local.validate().unwrap_err().contains("API Key"));
    }

    #[test]
    fn save_preserves_other_settings_and_removes_legacy_keys() {
        let directory =
            std::env::temp_dir().join(format!("noltri-settings-v2-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join("settings.json"), r#"{"apiBaseUrl":"http://localhost:9000","modelProfiles":[],"activeModelId":null,"custom":true}"#).unwrap();
        let settings = ModelSettings::default();
        save(&directory, &settings).unwrap();
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(directory.join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(value["custom"], true);
        assert!(value.get("modelProfiles").is_none());
        assert_eq!(value["providers"], serde_json::json!([]));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
