use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProfile {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSettings {
    #[serde(default)]
    pub model_profiles: Vec<ModelProfile>,
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

pub fn load(config_dir: Option<&Path>) -> DesktopSettings {
    let value = config_dir
        .and_then(|dir| std::fs::read(dir.join("settings.json")).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let models = value
        .as_ref()
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default();
    DesktopSettings {
        api_base_url: setting(
            value.as_ref(),
            "apiBaseUrl",
            "NOLTRI_API_BASE_URL",
            "http://127.0.0.1:8787",
        ),
        api_token: setting(value.as_ref(), "apiToken", "NOLTRI_ACCESS_TOKEN", ""),
        mcp_endpoint: setting(
            value.as_ref(),
            "mcpEndpoint",
            "NOLTRI_MCP_ENDPOINT",
            "http://127.0.0.1:8790/mcp",
        ),
        models,
    }
}

impl ModelSettings {
    pub fn validate(&mut self) -> Result<(), String> {
        if self.model_profiles.is_empty() || self.model_profiles.len() > 40 {
            return Err("请保留 1 至 40 个模型配置。".to_owned());
        }
        let mut ids = HashSet::new();
        for profile in &mut self.model_profiles {
            profile.name = profile.name.trim().to_owned();
            profile.base_url = profile.base_url.trim().trim_end_matches('/').to_owned();
            profile.api_key = profile.api_key.trim().to_owned();
            profile.model = profile.model.trim().to_owned();
            if profile.id.trim().is_empty() || !ids.insert(profile.id.clone()) {
                return Err("模型配置标识不能为空或重复。".to_owned());
            }
            if profile.id.len() > 200
                || profile.name.len() > 400
                || profile.model.len() > 800
                || profile.api_key.len() > 8000
                || profile.base_url.len() > 8000
            {
                return Err("模型配置字段过长，请检查输入。".to_owned());
            }
            if profile.name.is_empty() || profile.model.is_empty() || profile.api_key.is_empty() {
                return Err("请填写模型名称、Model ID 和 API Key。".to_owned());
            }
            if !matches!(profile.provider.as_str(), "deepseek" | "openai-compatible") {
                return Err("请选择支持的模型服务商。".to_owned());
            }
            let url = tauri::Url::parse(&profile.base_url).map_err(|_| "API 地址格式无效。")?;
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
            if url
                .path()
                .trim_end_matches('/')
                .ends_with("/chat/completions")
            {
                return Err(
                    "请填写 Base URL，例如 https://api.deepseek.com，不包含 /chat/completions。"
                        .to_owned(),
                );
            }
        }
        if !self
            .active_model_id
            .as_ref()
            .is_some_and(|id| ids.contains(id))
        {
            return Err("请选择当前使用的模型。".to_owned());
        }
        Ok(())
    }

    pub fn active(&self) -> Option<&ModelProfile> {
        self.model_profiles
            .iter()
            .find(|profile| Some(&profile.id) == self.active_model_id.as_ref())
    }
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
    value.insert(
        "modelProfiles".to_owned(),
        serde_json::to_value(&models.model_profiles).map_err(|error| error.to_string())?,
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

    #[test]
    fn model_profiles_validate_and_preserve_existing_connection_settings() {
        let directory =
            std::env::temp_dir().join(format!("noltri-settings-check-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            directory.join("settings.json"),
            r#"{"apiBaseUrl":"http://localhost:9000","custom":true}"#,
        )
        .unwrap();
        let mut models = ModelSettings {
            model_profiles: vec![ModelProfile {
                id: "one".into(),
                name: "DeepSeek".into(),
                provider: "deepseek".into(),
                base_url: "https://api.deepseek.com/".into(),
                api_key: "test-only".into(),
                model: "deepseek-flash".into(),
            }],
            active_model_id: Some("one".into()),
        };
        models.validate().unwrap();
        save(&directory, &models).unwrap();
        let loaded = load(Some(&directory));
        assert_eq!(loaded.api_base_url, "http://localhost:9000");
        assert_eq!(
            loaded.models.active().unwrap().base_url,
            "https://api.deepseek.com"
        );
        let value: serde_json::Value =
            serde_json::from_slice(&std::fs::read(directory.join("settings.json")).unwrap())
                .unwrap();
        assert_eq!(value["custom"], true);
        models.model_profiles.push(models.model_profiles[0].clone());
        assert!(models.validate().is_err());
        models.model_profiles.pop();
        models.model_profiles[0].base_url = "https://api.deepseek.com/chat/completions".into();
        assert!(models.validate().is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }
}
