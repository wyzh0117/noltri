//! Per-client connection facts and the two file operations Setup Manager is allowed to do.
//!
//! Boundary of responsibility (PROJECT_MASTER §2.7): Setup Manager may detect, guide, open the
//! official entry point and *prepare* configuration. Writing a file is only reachable after the
//! UI has shown the absolute path in an explicit confirmation dialog, and the merge itself — the
//! part that must never lose another server's entry — is implemented as a pure function in
//! `src/lib/mcp-config.ts` where it is unit-tested. This module only resolves platform paths and
//! performs the atomic write.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    ChatGptCodex,
    ClaudeDesktop,
    ClaudeCode,
    Cursor,
    Generic,
}

impl Target {
    pub fn from_key(key: &str) -> Option<Self> {
        match key.trim() {
            "chatgpt_codex" | "chatgpt" | "codex" => Some(Self::ChatGptCodex),
            "claude" | "claude_desktop" => Some(Self::ClaudeDesktop),
            "claude_code" => Some(Self::ClaudeCode),
            "cursor" => Some(Self::Cursor),
            "other_mcp_client" | "generic" | "mcp_client" => Some(Self::Generic),
            _ => None,
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Self::ChatGptCodex => "chatgpt_codex",
            Self::ClaudeDesktop => "claude_desktop",
            Self::ClaudeCode => "claude_code",
            Self::Cursor => "cursor",
            Self::Generic => "other_mcp_client",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::ChatGptCodex => "ChatGPT / Codex",
            Self::ClaudeDesktop => "Claude Desktop",
            Self::ClaudeCode => "Claude Code",
            Self::Cursor => "Cursor",
            Self::Generic => "其他 MCP Client",
        }
    }

    /// Relative to the user's home directory; `None` for clients with no local config file.
    fn config_relative_path(self) -> Option<&'static str> {
        match self {
            Self::ChatGptCodex => Some(".codex/config.toml"),
            Self::ClaudeDesktop => Some("Library/Application Support/Claude/claude_desktop_config.json"),
            Self::ClaudeCode => Some(".claude.json"),
            Self::Cursor => Some(".cursor/mcp.json"),
            Self::Generic => None,
        }
    }

    /// Only JSON `mcpServers` files belonging to the Claude family are ever written for the user;
    /// Codex stores TOML and Cursor / 其他客户端 are guided instead (V1 §12.2 step 3-4).
    pub fn write_supported(self) -> bool {
        matches!(self, Self::ClaudeDesktop | Self::ClaudeCode)
    }

    pub fn official_settings_url(self) -> &'static str {
        match self {
            Self::ChatGptCodex => "https://chatgpt.com/settings/connectors",
            Self::ClaudeDesktop => "https://www.anthropic.com/claude/desktop",
            Self::ClaudeCode => "https://claude.ai/login",
            Self::Cursor => "https://cursor.com/settings",
            Self::Generic => "https://modelcontextprotocol.io",
        }
    }

    pub fn docs_url(self) -> &'static str {
        match self {
            Self::ChatGptCodex => "https://developers.openai.com/codex/mcp",
            Self::ClaudeDesktop => "https://docs.claude.com/en/docs/claude-desktop/mcp",
            Self::ClaudeCode => "https://docs.claude.com/en/docs/claude-code/mcp",
            Self::Cursor => "https://docs.cursor.com/context/model-context-protocol",
            Self::Generic => "https://modelcontextprotocol.io",
        }
    }

    /// `.app` bundles whose existence we can honestly report as 「检测到已安装」.
    pub fn app_candidates(self) -> &'static [&'static str] {
        match self {
            Self::ChatGptCodex => &["ChatGPT.app", "Codex.app"],
            Self::ClaudeDesktop | Self::ClaudeCode => &["Claude.app"],
            Self::Cursor => &["Cursor.app"],
            Self::Generic => &[],
        }
    }

    /// Human-readable next step for the connect flow (V1 §12.2 steps 1-5).
    pub fn guidance(self) -> &'static str {
        match self {
            Self::ChatGptCodex => "在 ChatGPT 的连接器设置里添加远程 MCP，或把下面的条目写入 ~/.codex/config.toml。",
            Self::ClaudeDesktop => "写入后需要完全退出并重新打开 Claude Desktop，才会在 MCP 列表里看到知序。",
            Self::ClaudeCode => "也可以执行 `claude mcp add --transport http noltri <endpoint>`；写入 ~/.claude.json 会保留其它服务器。",
            Self::Cursor => "在 Cursor 的 Settings → MCP 中粘贴下面的条目（V1 不代写该文件）。",
            Self::Generic => "任何支持 Streamable HTTP 的 MCP Client 都可以连接同一个 endpoint。",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetFacts {
    pub target: &'static str,
    pub label: &'static str,
    pub server_name: &'static str,
    /// Absolute path we would write, `None` when the client has no local file.
    pub config_path: Option<String>,
    pub config_path_exists: bool,
    pub write_supported: bool,
    pub official_settings_url: &'static str,
    pub docs_url: &'static str,
    pub guidance: &'static str,
    pub installed_apps: Vec<String>,
    /// The endpoint this companion advertises, straight from settings.
    pub endpoint: String,
    pub core_base_url: String,
    pub token_configured: bool,
}

pub const SERVER_NAME: &str = "noltri";

/// File names this app is ever allowed to overwrite, whatever the caller passes in.
const ALLOWED_WRITE_NAMES: &[&str] = &[
    "claude_desktop_config.json",
    ".claude.json",
    "mcp.json",
    "settings.json",
];

pub fn resolve(target: Target, home: &Path, endpoint: String, core_base_url: String, token_configured: bool) -> TargetFacts {
    let config_path = target
        .config_relative_path()
        .map(|relative| home.join(relative))
        .filter(|path| {
            // A config file that does not exist yet is still a legitimate write target, but a
            // path escaping the home directory is not.
            path.starts_with(home)
        });
    let exists = config_path.as_deref().map(|path| path.is_file()).unwrap_or(false);
    let installed_apps = target
        .app_candidates()
        .iter()
        .filter(|name| is_installed_app(name))
        .map(|name| format!("/Applications/{name}"))
        .collect();
    TargetFacts {
        target: target.key(),
        label: target.label(),
        server_name: SERVER_NAME,
        config_path: config_path.and_then(|path| path.to_str().map(str::to_string)),
        config_path_exists: exists,
        write_supported: target.write_supported(),
        official_settings_url: target.official_settings_url(),
        docs_url: target.docs_url(),
        guidance: target.guidance(),
        installed_apps,
        endpoint,
        core_base_url,
        token_configured,
    }
}

fn is_installed_app(name: &str) -> bool {
    Path::new("/Applications").join(name).is_dir() || home_dir().join("Applications").join(name).is_dir()
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Read a config file for the TS merge function. Errors are returned as strings so the UI can show
/// the real reason instead of guessing.
pub fn read_text(path: &str, max_bytes: usize) -> Result<Option<String>, String> {
    let candidate = Path::new(path);
    if !candidate.is_absolute() {
        return Err("配置路径必须是绝对路径".to_string());
    }
    if !candidate.is_file() {
        return Ok(None);
    }
    let metadata = candidate.metadata().map_err(|error| error.to_string())?;
    if metadata.len() as usize > max_bytes {
        return Err(format!(
            "配置文件过大（{} 字节），拒绝读取；请手动检查",
            metadata.len()
        ));
    }
    let text = fs::read_to_string(candidate).map_err(|error| error.to_string())?;
    Ok(Some(text))
}

/// Atomic write (temp + rename) after the allowlist check. The caller in the UI has already shown
/// the absolute path and asked for confirmation; nothing here can invent a destination.
pub fn write_text_atomically(path: &str, contents: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(path);
    let file_name = candidate
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "无法解析文件名".to_string())?;
    if !ALLOWED_WRITE_NAMES.contains(&file_name) {
        return Err(format!("拒绝写入 {file_name}：不在允许的配置文件清单内"));
    }
    if contents.len() > 2_000_000 {
        return Err("内容过大，拒绝写入".to_string());
    }
    let parent = candidate
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .ok_or_else(|| "缺少父目录".to_string())?;
    if !parent.exists() {
        fs::create_dir_all(parent).map_err(|error| format!("创建目录失败：{error}"))?;
    }
    let tmp = parent.join(format!(".{}.noltri.tmp", file_name));
    fs::write(&tmp, contents).map_err(|error| format!("临时文件写入失败：{error}"))?;
    // Backup once, so a bad merge is always undoable by hand.
    if candidate.is_file() {
        let backup = parent.join(format!("{file_name}.noltri-backup"));
        let _ = fs::copy(candidate, backup);
    }
    fs::rename(&tmp, candidate).map_err(|error| format!("替换配置文件失败：{error}"))?;
    Ok(candidate.to_path_buf())
}

/// Open a URL / file with the system default handler. `open` is the official macOS entry point;
/// we never script the target app or touch its account state (PROJECT_MASTER §2.7).
pub fn open_with_system(url: &str) -> Result<(), String> {
    let trimmed = url.trim();
    if trimmed.is_empty()
        || !(trimmed.starts_with("https://")
            || trimmed.starts_with("http://")
            || trimmed.starts_with("x-apple.systempreferences:"))
    {
        return Err("只允许打开 http(s) 或 x-apple.systempreferences 链接".to_string());
    }
    let target = trimmed.to_string();
    std::thread::spawn(move || {
        let _ = std::process::Command::new("/usr/bin/open").arg(target).spawn();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_claude_family_files_are_writable_targets() {
        assert!(Target::from_key("claude").unwrap().write_supported());
        assert!(Target::from_key("claude_code").unwrap().write_supported());
        assert!(!Target::from_key("cursor").unwrap().write_supported());
        assert!(!Target::from_key("codex").unwrap().write_supported());
        assert!(!Target::from_key("other_mcp_client").unwrap().write_supported());
    }

    #[test]
    fn unknown_target_is_rejected() {
        assert!(Target::from_key("vs_code_insiders").is_none());
    }

    #[test]
    fn rejects_writes_outside_the_allowlist() {
        let error = write_text_atomically("/etc/passwd", "{}").unwrap_err();
        assert!(error.contains("拒绝写入"), "{error}");
    }
}
