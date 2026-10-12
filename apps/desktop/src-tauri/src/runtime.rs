//! Starts bundled Core/MCP only when their local endpoints are not already healthy.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

pub const DEFAULT_PORT: u16 = 8787;
/// The MCP server's port (`MCP_PORT` default in `services/mcp-server`); the endpoint written into
/// client configs is `http://127.0.0.1:8790/mcp`.
pub const MCP_PORT: u16 = 8790;

/// How long the managed runtime gets to answer the health probes before it is declared failed.
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const PROBE_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Clone, Debug, PartialEq)]
pub enum CoreStatus {
    /// Probe still running / process not resolved yet.
    Starting,
    /// Something already answers on the port; we treat it as the user's runtime and do not own it.
    External,
    /// Dev run: the runtime belongs to the developer's terminal, not to this process.
    DevManual,
    /// We spawned the bundled runtime (Core + MCP) and both passed their identity probes.
    Managed,
    /// We spawned the bundled runtime but it never became healthy.
    Failed(String),
}

#[derive(Default)]
pub struct CoreRuntimeHandle {
    status: Mutex<Option<CoreStatus>>,
    children: Mutex<Vec<CommandChild>>,
}

impl CoreRuntimeHandle {
    pub fn status(&self) -> CoreStatus {
        self.lock(&self.status)
            .clone()
            .unwrap_or(CoreStatus::Starting)
    }

    fn set(&self, status: CoreStatus) {
        *self.lock(&self.status) = Some(status);
    }

    /// Kills only the children this process spawned. An external runtime (another app instance, a
    /// developer terminal) is never touched.
    pub fn stop(&self) {
        for child in self.lock(&self.children).drain(..) {
            let _ = child.kill();
        }
    }

    fn lock<'a, T>(&self, mutex: &'a Mutex<T>) -> MutexGuard<'a, T> {
        mutex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// One identity probe: an HTTP/1.0 GET whose response must contain every marker.
fn probe_http(port: u16, path: &str, markers: &[&str]) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(400)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let request =
        format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    markers.iter().all(|marker| response.contains(marker))
}

/// True when a Noltri Core (and not just any process) answers `GET /api/health` on the port.
pub fn probe(port: u16) -> bool {
    probe_http(port, "/api/health", &["\"productId\"", "noltri"])
}

fn probe_mcp(port: u16) -> bool {
    probe_http(port, "/healthz", &["noltri-knowledge"])
}

/// Spawns one bundled script with the pinned runtime and a shared drain thread.
///
/// `script_name` is `&'static str` because the drain thread captures it by move.
fn spawn_script(
    app: &AppHandle,
    handle: &Arc<CoreRuntimeHandle>,
    script_name: &'static str,
    envs: &[(&str, String)],
) -> Result<(), String> {
    let script = app
        .path()
        .resolve(format!("resources/{script_name}"), BaseDirectory::Resource)
        .map_err(|error| format!("无法定位随包脚本 {script_name}：{error}"))?;
    let mut command = app
        .shell()
        .sidecar("noltri-runtime")
        .map_err(|error| format!("随包运行时不可用：{error}"))?
        .args([script.to_string_lossy().to_string()]);
    for (key, value) in envs {
        command = command.env(key, value);
    }
    let (mut events, child) = command
        .spawn()
        .map_err(|error| format!("随包运行时启动失败（{script_name}）：{error}"))?;
    handle.lock(&handle.children).push(child);

    // Drain stdout/stderr so a chatty process can never block on a full pipe.
    std::thread::spawn(move || {
        while let Some(event) = events.blocking_recv() {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    eprintln!("[noltri-run] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[noltri-run] {script_name} exited: {payload:?}");
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

/// Uses the app data directory only as the default; explicit profile/database paths belong to the
/// caller and must reach the bundled Core unchanged.
fn runtime_storage_env(
    default_data_dir: std::path::PathBuf,
    mut get_env: impl FnMut(&str) -> Option<String>,
) -> (std::path::PathBuf, Vec<(&'static str, String)>) {
    let data_dir = get_env("NOLTRI_DATA_DIR")
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or(default_data_dir);
    let mut envs = vec![
        ("STORAGE_DRIVER", "sqlite".to_owned()),
        ("NOLTRI_DATA_DIR", data_dir.to_string_lossy().into_owned()),
    ];
    for key in ["NOLTRI_SQLITE_FILE", "NOLTRI_GRANT_FILE"] {
        if let Some(value) = get_env(key).filter(|value| !value.is_empty()) {
            envs.push((key, value));
        }
    }
    (data_dir, envs)
}

/// Decides who owns the local runtime for this session and, in packaged builds with nobody
/// answering, starts the bundled runtime. Never blocks the caller beyond the initial probe.
pub fn start(app: AppHandle, handle: Arc<CoreRuntimeHandle>) {
    let core_ready = probe(DEFAULT_PORT);
    let mcp_ready = probe_mcp(MCP_PORT);
    if core_ready && mcp_ready {
        handle.set(CoreStatus::External);
        eprintln!("[noltri] 检测到已运行的 Core 与 MCP，按外部运行时处理");
        return;
    }
    if tauri::is_dev() {
        handle.set(CoreStatus::DevManual);
        eprintln!("[noltri] dev 模式：不拉起随包运行时（请手动运行 knowledge-core 与 mcp-server）");
        return;
    }
    let default_data_dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(error) => {
            handle.set(CoreStatus::Failed(format!("无法解析数据目录：{error}")));
            return;
        }
    };
    let (data_dir, core_envs) =
        runtime_storage_env(default_data_dir, |key| std::env::var(key).ok());
    if let Err(error) = std::fs::create_dir_all(&data_dir) {
        handle.set(CoreStatus::Failed(format!("数据目录不可写：{error}")));
        return;
    }
    let data_dir = data_dir.to_string_lossy().into_owned();
    if !core_ready {
        if let Err(reason) = spawn_script(&app, &handle, "core-server.mjs", &core_envs) {
            handle.set(CoreStatus::Failed(reason));
            return;
        }
    }
    if !mcp_ready {
        let mcp_envs = [
            (
                "KNOWLEDGE_API_URL",
                format!("http://127.0.0.1:{DEFAULT_PORT}"),
            ),
            ("NOLTRI_DATA_DIR", data_dir),
        ];
        if let Err(reason) = spawn_script(&app, &handle, "mcp-server.mjs", &mcp_envs) {
            handle.stop();
            handle.set(CoreStatus::Failed(reason));
            return;
        }
    }

    // Resolve readiness off the setup thread, allowing a competing app instance to win startup.
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + READY_TIMEOUT;
        let mut core_ready = false;
        let mut mcp_ready = false;
        while std::time::Instant::now() < deadline {
            if matches!(handle.status(), CoreStatus::Failed(_)) {
                return;
            }
            if !core_ready {
                core_ready = probe(DEFAULT_PORT);
            }
            if !mcp_ready {
                mcp_ready = probe_mcp(MCP_PORT);
            }
            if core_ready && mcp_ready {
                handle.set(CoreStatus::Managed);
                eprintln!("[noltri] 随包运行时已就绪（Core :{DEFAULT_PORT}，MCP :{MCP_PORT}）");
                return;
            }
            std::thread::sleep(PROBE_INTERVAL);
        }
        let reason = if !core_ready {
            "Core 健康检查超时"
        } else {
            "MCP 健康检查超时"
        };
        handle.set(CoreStatus::Failed(reason.to_string()));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_reports_nothing_on_a_port_nobody_listens_on() {
        // Port 9 (discard) is not served on macOS by default; an arbitrary high port is not
        // guaranteed to be free, this one is reserved and closed.
        assert!(!probe(9));
    }

    #[test]
    fn stop_without_a_child_is_a_no_op() {
        let handle = CoreRuntimeHandle::default();
        handle.stop();
        assert_eq!(handle.status(), CoreStatus::Starting);
    }

    #[test]
    fn explicit_profile_and_database_paths_reach_the_bundled_core() {
        let default_dir = std::env::temp_dir().join("noltri-default-profile");
        let override_dir = std::env::temp_dir().join("noltri-runtime-isolation-check");
        let data_dir_value = override_dir.to_string_lossy().into_owned();
        let sqlite_file = override_dir
            .join("library.sqlite")
            .to_string_lossy()
            .into_owned();
        let grant_file = override_dir
            .join("grants.json")
            .to_string_lossy()
            .into_owned();
        let mut supplied = std::collections::HashMap::new();
        supplied.insert("NOLTRI_DATA_DIR", data_dir_value.clone());
        supplied.insert("NOLTRI_SQLITE_FILE", sqlite_file.clone());
        supplied.insert("NOLTRI_GRANT_FILE", grant_file.clone());

        let (data_dir, envs) =
            runtime_storage_env(default_dir.clone(), |key| supplied.get(key).cloned());
        let value = |key: &str| {
            envs.iter()
                .find(|(name, _)| *name == key)
                .map(|(_, value)| value.as_str())
        };

        assert_eq!(data_dir, override_dir);
        assert_eq!(value("NOLTRI_DATA_DIR"), Some(data_dir_value.as_str()));
        assert_eq!(value("NOLTRI_SQLITE_FILE"), Some(sqlite_file.as_str()));
        assert_eq!(value("NOLTRI_GRANT_FILE"), Some(grant_file.as_str()));
        assert_ne!(data_dir, default_dir);

        let (fallback_dir, fallback_envs) = runtime_storage_env(default_dir.clone(), |_| None);
        assert_eq!(fallback_dir, default_dir);
        assert_eq!(
            fallback_envs
                .iter()
                .find(|(name, _)| *name == "NOLTRI_DATA_DIR")
                .map(|(_, value)| value.as_str()),
            Some(default_dir.to_string_lossy().as_ref())
        );
        assert!(!fallback_envs
            .iter()
            .any(|(name, _)| *name == "NOLTRI_SQLITE_FILE" || *name == "NOLTRI_GRANT_FILE"));
    }
}
