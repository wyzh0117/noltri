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
    Hermes,
    Qoder,
    Generic,
}

/// What Setup Manager is actually allowed to claim about a client (V1 §11: 没有真实握手与调用证据不得标
/// 「已支持」；M06 要求「不支持／待人工配置／未验证」必须是可见的第三种状态）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Support {
    /// The config file format is known well enough to merge into it on the user's behalf.
    Writable,
    /// Format known, entry prepared, but writing is left to the user.
    Guided,
    /// Detected on this machine, but its MCP registration path has not been verified. Never shown as connected.
    Unverified,
}

impl Support {
    pub fn key(self) -> &'static str {
        match self {
            Self::Writable => "writable",
            Self::Guided => "guided",
            Self::Unverified => "unverified",
        }
    }
}

impl Target {
    pub fn from_key(key: &str) -> Option<Self> {
        match key.trim() {
            "chatgpt_codex" | "chatgpt" | "codex" => Some(Self::ChatGptCodex),
            "claude" | "claude_desktop" => Some(Self::ClaudeDesktop),
            "claude_code" => Some(Self::ClaudeCode),
            "cursor" => Some(Self::Cursor),
            "hermes" => Some(Self::Hermes),
            "qoder" => Some(Self::Qoder),
            "other_mcp_client" | "generic" | "mcp_client" => Some(Self::Generic),
            _ => None,
        }
    }

    /// Every card the Setup Manager shows, in display order.
    pub const ALL: [Target; 7] = [
        Self::ClaudeDesktop,
        Self::ClaudeCode,
        Self::ChatGptCodex,
        Self::Cursor,
        Self::Hermes,
        Self::Qoder,
        Self::Generic,
    ];

    pub fn key(self) -> &'static str {
        match self {
            Self::ChatGptCodex => "chatgpt_codex",
            Self::ClaudeDesktop => "claude_desktop",
            Self::ClaudeCode => "claude_code",
            Self::Cursor => "cursor",
            Self::Hermes => "hermes",
            Self::Qoder => "qoder",
            Self::Generic => "other_mcp_client",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::ChatGptCodex => "ChatGPT / Codex",
            Self::ClaudeDesktop => "Claude Desktop",
            Self::ClaudeCode => "Claude Code",
            Self::Cursor => "Cursor",
            Self::Hermes => "Hermes",
            Self::Qoder => "Qoder",
            Self::Generic => "其他 MCP Client",
        }
    }

    /// Relative to the user's home directory; `None` for clients with no local config file — and for
    /// clients whose file we have not verified, because guessing a path is how another product's
    /// settings get overwritten (§11: 不凭名称写死配置文件).
    fn config_relative_path(self) -> Option<&'static str> {
        match self {
            Self::ChatGptCodex => Some(".codex/config.toml"),
            Self::ClaudeDesktop => Some("Library/Application Support/Claude/claude_desktop_config.json"),
            Self::ClaudeCode => Some(".claude.json"),
            Self::Cursor => Some(".cursor/mcp.json"),
            Self::Hermes | Self::Qoder | Self::Generic => None,
        }
    }

    pub fn support(self) -> Support {
        match self {
            Self::ClaudeDesktop | Self::ClaudeCode => Support::Writable,
            Self::ChatGptCodex | Self::Cursor | Self::Generic => Support::Guided,
            Self::Hermes | Self::Qoder => Support::Unverified,
        }
    }

    /// Only JSON `mcpServers` files belonging to the Claude family are ever written for the user;
    /// Codex stores TOML and Cursor / 其他客户端 are guided instead (V1 §12.2 step 3-4).
    pub fn write_supported(self) -> bool {
        self.support() == Support::Writable
    }

    /// `None` when we have no verified official entry point to hand the user to — an invented URL would
    /// be worse than no button at all.
    pub fn official_settings_url(self) -> Option<&'static str> {
        match self {
            Self::ChatGptCodex => Some("https://chatgpt.com/settings/connectors"),
            Self::ClaudeDesktop => Some("https://www.anthropic.com/claude/desktop"),
            Self::ClaudeCode => Some("https://claude.ai/login"),
            Self::Cursor => Some("https://cursor.com/settings"),
            Self::Hermes | Self::Qoder | Self::Generic => None,
        }
    }

    pub fn docs_url(self) -> Option<&'static str> {
        match self {
            Self::ChatGptCodex => Some("https://developers.openai.com/codex/mcp"),
            Self::ClaudeDesktop => Some("https://docs.claude.com/en/docs/claude-desktop/mcp"),
            Self::ClaudeCode => Some("https://docs.claude.com/en/docs/claude-code/mcp"),
            Self::Cursor => Some("https://docs.cursor.com/context/model-context-protocol"),
            Self::Hermes | Self::Qoder => None,
            Self::Generic => Some("https://modelcontextprotocol.io"),
        }
    }

    /// `.app` bundles whose existence we can honestly report as 「检测到已安装」.
    pub fn app_candidates(self) -> &'static [&'static str] {
        match self {
            Self::ChatGptCodex => &["ChatGPT.app", "Codex.app"],
            Self::ClaudeDesktop | Self::ClaudeCode => &["Claude.app"],
            Self::Cursor => &["Cursor.app"],
            Self::Hermes => &["Hermes.app"],
            Self::Qoder => &["Qoder.app"],
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
            Self::Hermes => "已检测到本机安装，但其 MCP 注册方式本轮未经真实握手验证：请在该客户端内手动添加，验证前不显示为已连接。",
            Self::Qoder => "已检测到本机安装，但其 MCP 注册方式本轮未经真实握手验证：请在该客户端内手动添加，验证前不显示为已连接。",
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
    /// `writable` / `guided` / `unverified` — the UI must render this, not a guess derived from the other flags.
    pub support_state: &'static str,
    pub official_settings_url: Option<String>,
    pub docs_url: Option<String>,
    pub guidance: &'static str,
    pub installed_apps: Vec<String>,
    /// `.app` bundle we actually found, and the version its own Info.plist reports.
    pub app_path: Option<String>,
    pub app_version: Option<String>,
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

pub fn resolve(
    target: Target,
    home: &Path,
    endpoint: String,
    core_base_url: String,
    token_configured: bool,
) -> TargetFacts {
    resolve_with(
        target,
        home,
        endpoint,
        core_base_url,
        token_configured,
        &installed_bundles,
        &bundle_version,
    )
}

/// `finder` and `version_of` are seams: the reporting logic has to be testable without depending on
/// which apps happen to be installed on the machine running the test.
pub fn resolve_with(
    target: Target,
    home: &Path,
    endpoint: String,
    core_base_url: String,
    token_configured: bool,
    finder: &dyn Fn(Target) -> Vec<PathBuf>,
    version_of: &dyn Fn(&Path) -> Option<String>,
) -> TargetFacts {
    let config_path = target
        .config_relative_path()
        .map(|relative| home.join(relative))
        .filter(|path| {
            // A config file that does not exist yet is still a legitimate write target, but a
            // path escaping the home directory is not.
            path.starts_with(home)
        });
    let exists = config_path.as_deref().map(|path| path.is_file()).unwrap_or(false);
    let bundles = finder(target);
    let installed_apps = bundles
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect();
    let app_path = bundles.first().cloned();
    let app_version = app_path.as_deref().and_then(version_of);
    TargetFacts {
        target: target.key(),
        label: target.label(),
        server_name: SERVER_NAME,
        config_path: config_path.and_then(|path| path.to_str().map(str::to_string)),
        config_path_exists: exists,
        write_supported: target.write_supported(),
        support_state: target.support().key(),
        official_settings_url: target.official_settings_url().map(str::to_string),
        docs_url: target.docs_url().map(str::to_string),
        guidance: target.guidance(),
        installed_apps,
        app_path: app_path.and_then(|path| path.to_str().map(str::to_string)),
        app_version,
        endpoint,
        core_base_url,
        token_configured,
    }
}

/// `.app` bundles for this target, system location first, then the user's own Applications folder.
fn installed_bundles(target: Target) -> Vec<PathBuf> {
    target
        .app_candidates()
        .iter()
        .filter_map(|name| {
            let system = Path::new("/Applications").join(name);
            if system.is_dir() {
                return Some(system);
            }
            let user = home_dir().join("Applications").join(name);
            if user.is_dir() {
                Some(user)
            } else {
                None
            }
        })
        .collect()
}

/// Ask the bundle itself which version it is, using Apple's own reader and an argument array — never a
/// assembled shell string (§11). A missing or absurd value reports `None`, which the UI shows as
/// 「版本未知」 rather than a number invented from the app's name.
pub fn bundle_version(bundle: &Path) -> Option<String> {
    let plist = bundle.join("Contents").join("Info.plist");
    let output = std::process::Command::new("/usr/bin/plutil")
        .arg("-extract")
        .arg("CFBundleShortVersionString")
        .arg("raw")
        .arg(&plist)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() || trimmed.len() > 64 || trimmed.contains('\n') || trimmed.contains("(null)") {
        return None;
    }
    Some(trimmed.to_string())
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

    fn fake_finder(name: &'static str) -> impl Fn(Target) -> Vec<PathBuf> {
        move |target| {
            if target.app_candidates().contains(&name) {
                vec![PathBuf::from("/fake/Applications").join(name)]
            } else {
                Vec::new()
            }
        }
    }

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

    /// M06: an agent we can see but have not handshaked with must be reported as unverified, with no
    /// config path to write and no invented URL to open.
    #[test]
    fn detected_but_unverified_agents_get_no_write_path_and_no_url() {
        for key in ["hermes", "qoder"] {
            let target = Target::from_key(key).unwrap();
            let facts = resolve_with(
                target,
                Path::new("/Users/tester"),
                "http://127.0.0.1:8790/mcp".to_string(),
                "http://127.0.0.1:8787".to_string(),
                true,
                &fake_finder(if key == "hermes" { "Hermes.app" } else { "Qoder.app" }),
                &|_| Some("1.2.3".to_string()),
            );
            assert_eq!(facts.support_state, "unverified", "{key}");
            assert!(!facts.write_supported, "{key}");
            assert!(facts.config_path.is_none(), "{key}");
            assert!(facts.official_settings_url.is_none(), "{key}");
            assert!(facts.docs_url.is_none(), "{key}");
            assert_eq!(facts.app_version.as_deref(), Some("1.2.3"), "{key}");
            assert_eq!(facts.installed_apps.len(), 1, "{key}");
        }
    }

    #[test]
    fn writable_and_guided_states_are_distinguished() {
        let claude = Target::from_key("claude").unwrap().support().key();
        let cursor = Target::from_key("cursor").unwrap().support().key();
        let generic = Target::from_key("other_mcp_client").unwrap().support().key();
        assert_eq!(claude, "writable");
        assert_eq!(cursor, "guided");
        assert_eq!(generic, "guided");
    }

    #[test]
    fn an_absent_agent_reports_no_version() {
        let facts = resolve_with(
            Target::Hermes,
            Path::new("/Users/tester"),
            "http://127.0.0.1:8790/mcp".to_string(),
            "http://127.0.0.1:8787".to_string(),
            false,
            &|_| Vec::new(),
            &|_| panic!("must not read a version for a bundle that was not found"),
        );
        assert!(facts.installed_apps.is_empty());
        assert!(facts.app_path.is_none());
        assert!(facts.app_version.is_none());
    }

    /// The version comes from the bundle's own Info.plist, read by Apple's tool with an argument array.
    #[test]
    fn bundle_version_reads_the_plist_and_refuses_junk() {
        let root = std::env::temp_dir().join(format!("noltri-plist-{}", std::process::id()));
        let bundle = root.join("Test.app");
        std::fs::create_dir_all(bundle.join("Contents")).unwrap();
        std::fs::write(
            bundle.join("Contents").join("Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>7.3.1</string></dict></plist>"#,
        )
        .unwrap();
        assert_eq!(bundle_version(&bundle).as_deref(), Some("7.3.1"));

        std::fs::write(bundle.join("Contents").join("Info.plist"), "<plist><dict></dict></plist>").unwrap();
        assert_eq!(bundle_version(&bundle), None);

        assert_eq!(bundle_version(&root.join("Missing.app")), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn every_declared_target_is_routable() {
        for target in Target::ALL {
            assert_eq!(Target::from_key(target.key()), Some(target), "{}", target.key());
        }
        assert_eq!(Target::ALL.len(), 7);
    }
}
