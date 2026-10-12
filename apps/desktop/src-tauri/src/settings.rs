use std::path::Path;

pub struct DesktopSettings {
    pub api_base_url: String,
    pub api_token: String,
    pub mcp_endpoint: String,
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
    let value = value.as_ref();
    DesktopSettings {
        api_base_url: setting(
            value,
            "apiBaseUrl",
            "NOLTRI_API_BASE_URL",
            "http://127.0.0.1:8787",
        ),
        api_token: setting(value, "apiToken", "NOLTRI_ACCESS_TOKEN", ""),
        mcp_endpoint: setting(
            value,
            "mcpEndpoint",
            "NOLTRI_MCP_ENDPOINT",
            "http://127.0.0.1:8790/mcp",
        ),
    }
}
