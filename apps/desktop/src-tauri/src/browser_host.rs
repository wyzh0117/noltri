//! Browser native-messaging registration for the *installed* app (M05).
//!
//! A browser launches the manifest's `path` with the extension origin as its only argument, so the
//! registered executable cannot be the Node runtime itself — it has to be a launcher script that
//! execs `noltri-runtime <host.mjs> "$@"`. The launcher lives in the app data directory and always
//! points at this app bundle's runtime and resources, which is what makes a repaired registration
//! stop referring to a development directory.
//!
//! In `tauri dev` there is no bundle, so repair refuses and points at the documented dev command
//! instead of writing a registration that points into `target/`.

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

pub const LAUNCHER_NAME: &str = "noltri-native-host";

/// The exact bytes of the launcher, kept pure so a test can pin its contract.
pub fn launcher_script(runtime: &str, script: &str) -> String {
    format!(
        "#!/bin/sh\n# 知序 Companion 浏览器采集通道入口（由 Setup Manager 写入，可安全覆盖）\nexec \"{runtime}\" \"{script}\" \"$@\"\n"
    )
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHostStatus {
    /// False in dev builds: registration is only offered where a bundle exists.
    pub serviceable: bool,
    pub note: String,
    pub launcher_path: String,
    pub launcher_present: bool,
    /// The browser manifest file this machine would use (first line of `install-cli paths`).
    pub manifest_file: Option<String>,
    /// The `path` currently recorded in that manifest, when one exists.
    pub current_executable: Option<String>,
    /// True when the recorded path is exactly our launcher — i.e. nothing to repair.
    pub managed: Option<bool>,
}

fn launcher_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法解析数据目录：{error}"))?;
    Ok(dir.join("host").join(LAUNCHER_NAME))
}

/// Where the sidecar lands in a bundle: next to the main executable (`Contents/MacOS`).
fn runtime_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|error| format!("无法定位应用可执行文件：{error}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "应用可执行文件没有父目录".to_string())?;
    Ok(dir.join("noltri-runtime"))
}

fn resource_script(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .resolve("resources/host.mjs", BaseDirectory::Resource)
        .map_err(|error| format!("无法定位随包 host 脚本：{error}"))
}

/// Runs the bundled registration CLI with the pinned runtime and returns (code, stdout, stderr).
async fn run_cli(app: &AppHandle, args: Vec<String>) -> Result<(i32, String, String), String> {
    let script = app
        .path()
        .resolve("resources/install-cli.mjs", BaseDirectory::Resource)
        .map_err(|error| format!("无法定位随包注册脚本：{error}"))?;
    let mut all = vec![script.to_string_lossy().to_string()];
    all.extend(args);
    let output = app
        .shell()
        .sidecar("noltri-runtime")
        .map_err(|error| format!("随包运行时不可用：{error}"))?
        .args(all)
        .output()
        .await
        .map_err(|error| format!("随包运行时启动失败：{error}"))?;
    Ok((
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    ))
}

fn read_manifest_executable(file: &str) -> Option<String> {
    let contents = fs::read_to_string(file).ok()?;
    let value: serde_json::Value = serde_json::from_str(&contents).ok()?;
    value.get("path")?.as_str().map(str::to_string)
}

pub async fn status(app: &AppHandle) -> Result<BrowserHostStatus, String> {
    let launcher = launcher_path(app)?;
    let launcher_present = launcher.is_file();
    let base = BrowserHostStatus {
        serviceable: !tauri::is_dev(),
        note: String::new(),
        launcher_path: launcher.display().to_string(),
        launcher_present,
        manifest_file: None,
        current_executable: None,
        managed: None,
    };
    if tauri::is_dev() {
        return Ok(BrowserHostStatus {
            note: "开发模式不代写浏览器注册；请用文档中的 install-cli 命令。安装版会在你确认后写入随包入口。"
                .to_string(),
            ..base
        });
    }
    let (_, stdout, stderr) = run_cli(app, vec!["paths".to_string()]).await?;
    let manifest_file = stdout
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("注册 CLI 没有返回 manifest 路径：{stderr}"))?;
    let current_executable = read_manifest_executable(&manifest_file);
    let managed = current_executable
        .as_ref()
        .map(|exe| exe == &base.launcher_path);
    Ok(BrowserHostStatus {
        manifest_file: Some(manifest_file),
        current_executable,
        managed,
        note: if base.launcher_present {
            String::new()
        } else {
            "尚未写入随包入口；注册或修复时会先写入它。".to_string()
        },
        ..base
    })
}

/// Writes (or refreshes) the launcher and then asks the CLI to register it. Without `confirm`
/// the CLI only prints the preview; nothing outside our own data directory is touched.
pub async fn repair(
    app: &AppHandle,
    extension_ids: &[String],
    browser: &str,
    confirm: bool,
) -> Result<String, String> {
    if tauri::is_dev() {
        return Err("开发模式不代写浏览器注册；请用文档中的 install-cli 命令。".to_string());
    }
    let ids: Vec<String> = extension_ids
        .iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    if ids.is_empty() {
        return Err("至少填写一个扩展 ID（chrome-extension:// 后面的 32 位 id）".to_string());
    }
    let launcher = launcher_path(app)?;
    if confirm {
        let runtime = runtime_path()?;
        let script = resource_script(app)?;
        if let Some(dir) = launcher.parent() {
            fs::create_dir_all(dir).map_err(|error| format!("无法创建入口目录：{error}"))?;
        }
        fs::write(&launcher, launcher_script(&runtime.display().to_string(), &script.display().to_string()))
            .map_err(|error| format!("无法写入随包入口：{error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&launcher, fs::Permissions::from_mode(0o755))
                .map_err(|error| format!("无法设置入口权限：{error}"))?;
        }
    }
    let mut args = vec![
        "install".to_string(),
        "--host".to_string(),
        launcher.display().to_string(),
        "--browser".to_string(),
        browser.to_string(),
    ];
    for id in &ids {
        args.push("--extension-id".to_string());
        args.push(id.clone());
    }
    if confirm {
        args.push("--confirm".to_string());
    }
    let (code, stdout, stderr) = run_cli(app, args).await?;
    if code != 0 {
        return Err(format!("{}\n{}", stdout.trim(), stderr.trim()).trim().to_string());
    }
    Ok(stdout.trim().to_string())
}

/// Retires the manifest this machine has for `browser`, restoring any earlier one (the CLI backs
/// it up before writing). Read-only when nothing is registered.
pub async fn uninstall(app: &AppHandle, browser: &str) -> Result<String, String> {
    if tauri::is_dev() {
        return Err("开发模式不代写浏览器注册；请用文档中的 install-cli 命令。".to_string());
    }
    let (code, stdout, stderr) = run_cli(
        app,
        vec![
            "uninstall".to_string(),
            "--browser".to_string(),
            browser.to_string(),
        ],
    )
    .await?;
    if code != 0 {
        return Err(format!("{}\n{}", stdout.trim(), stderr.trim()).trim().to_string());
    }
    Ok(stdout.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launcher_execs_the_runtime_with_the_script_and_passes_origin_through() {
        let script = launcher_script("/A/知序 Companion.app/Contents/MacOS/noltri-runtime", "/A/知序 Companion.app/Contents/Resources/resources/host.mjs");
        assert!(script.starts_with("#!/bin/sh\n"));
        assert!(script.contains("exec \"/A/知序 Companion.app/Contents/MacOS/noltri-runtime\" \"/A/知序 Companion.app/Contents/Resources/resources/host.mjs\" \"$@\""));
        // The browser passes the origin as argv[1]; "$@" is the only correct way to carry it.
        assert!(script.ends_with("\n"));
    }

    #[test]
    fn manifest_reader_returns_only_a_string_path() {
        let dir = std::env::temp_dir().join(format!("noltri-bh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("m.json");
        std::fs::write(&file, r#"{"name":"com.noltri.knowledge_host","path":"/x/noltri-native-host"}"#).unwrap();
        assert_eq!(
            read_manifest_executable(file.to_str().unwrap()),
            Some("/x/noltri-native-host".to_string())
        );
        std::fs::write(&file, "not json").unwrap();
        assert_eq!(read_manifest_executable(file.to_str().unwrap()), None);
        assert_eq!(read_manifest_executable("/definitely/missing.json"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
