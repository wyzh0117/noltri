//! Managed local runtime (Knowledge Core + MCP server).
//!
//! Packaged builds own the local runtime: [`start`] probes `127.0.0.1:8787` for an already healthy
//! Noltri Core, and when none answers it starts the bundled sidecars — `core-server.mjs` with the
//! app's data directory, then `mcp-server.mjs` pointed at that Core (port 8790) so 「AI 连接」 has
//! something to connect to. In `tauri dev` the developer starts both themselves, so nothing is
//! spawned — the Setup Manager still sees an external Core.
//!
//! The probes are hand-rolled HTTP/1.0 GETs over `TcpStream`: the native layer deliberately
//! carries no TLS/HTTP stack in V1 (see `commands.rs`), and the identity check only needs to
//! confirm that *a Noltri service* answers — not to trust arbitrary JSON on the port.

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

impl CoreStatus {
    pub fn label(&self) -> String {
        match self {
            Self::Starting => "starting".to_string(),
            Self::External => "external".to_string(),
            Self::DevManual => "dev-manual".to_string(),
            Self::Managed => "managed".to_string(),
            Self::Failed(reason) => format!("failed: {reason}"),
        }
    }
}

#[derive(Default)]
pub struct CoreRuntimeHandle {
    status: Mutex<Option<CoreStatus>>,
    children: Mutex<Vec<CommandChild>>,
}

impl CoreRuntimeHandle {
    pub fn status(&self) -> CoreStatus {
        self.lock(&self.status).clone().unwrap_or(CoreStatus::Starting)
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
        mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// One identity probe: an HTTP/1.0 GET whose response must contain every marker.
fn probe_http(port: u16, path: &str, markers: &[&str]) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(400)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
    let request = format!("GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
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
    envs: &[(&str, &str)],
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
        command = command.env(*key, *value);
    }
    let (mut events, child) = command
        .spawn()
        .map_err(|error| format!("随包运行时启动失败（{script_name}）：{error}"))?;
    handle.lock(&handle.children).push(child);

    // Drain stdout/stderr so a chatty process can never block on a full pipe.
    let drain_handle = handle.clone();
    std::thread::spawn(move || {
        while let Some(event) = events.blocking_recv() {
            match event {
                CommandEvent::Stdout(line) | CommandEvent::Stderr(line) => {
                    eprintln!("[noltri-run] {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    eprintln!("[noltri-run] {script_name} exited: {payload:?}");
                    if drain_handle.status() != CoreStatus::Managed {
                        drain_handle.set(CoreStatus::Failed(format!("{script_name} 提前退出：{payload:?}")));
                    }
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

/// Decides who owns the local runtime for this session and, in packaged builds with nobody
/// answering, starts the bundled runtime. Never blocks the caller beyond the initial probe.
pub fn start(app: AppHandle, handle: Arc<CoreRuntimeHandle>) {
    if probe(DEFAULT_PORT) {
        handle.set(CoreStatus::External);
        eprintln!("[noltri] 检测到已在运行的 Core（127.0.0.1:{DEFAULT_PORT}），按外部运行时处理");
        return;
    }
    if tauri::is_dev() {
        handle.set(CoreStatus::DevManual);
        eprintln!("[noltri] dev 模式：不拉起随包运行时（请手动运行 knowledge-core 与 mcp-server）");
        return;
    }
    let data_dir = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(error) => {
            handle.set(CoreStatus::Failed(format!("无法解析数据目录：{error}")));
            return;
        }
    };
    if let Err(error) = std::fs::create_dir_all(&data_dir) {
        handle.set(CoreStatus::Failed(format!("数据目录不可写：{error}")));
        return;
    }
    let data_dir = data_dir.to_string_lossy().to_string();
    if let Err(reason) = spawn_script(
        &app,
        &handle,
        "core-server.mjs",
        &[("STORAGE_DRIVER", "sqlite"), ("NOLTRI_DATA_DIR", &data_dir)],
    ) {
        handle.set(CoreStatus::Failed(reason));
        return;
    }
    if let Err(reason) = spawn_script(
        &app,
        &handle,
        "mcp-server.mjs",
        &[("KNOWLEDGE_API_URL", &format!("http://127.0.0.1:{DEFAULT_PORT}"))],
    ) {
        handle.set(CoreStatus::Failed(reason));
        return;
    }

    // Wait for both health checks off the setup thread; the UI polls `runtime_info` for the verdict.
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
    fn status_labels_stay_stable_for_the_ui() {
        assert_eq!(CoreStatus::Starting.label(), "starting");
        assert_eq!(CoreStatus::External.label(), "external");
        assert_eq!(CoreStatus::DevManual.label(), "dev-manual");
        assert_eq!(CoreStatus::Managed.label(), "managed");
        assert_eq!(CoreStatus::Failed("x".to_string()).label(), "failed: x");
    }

    #[test]
    fn stop_without_a_child_is_a_no_op() {
        let handle = CoreRuntimeHandle::default();
        handle.stop();
        assert_eq!(handle.status(), CoreStatus::Starting);
    }
}
