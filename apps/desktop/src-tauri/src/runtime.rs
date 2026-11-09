//! Owns both isolated Core/MCP children, or explicitly authenticates an external runtime.

#[path = "runtime_ownership.rs"]
mod ownership;

use serde::Serialize;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use ownership::{ChildControl, ChildExit, ChildLedger, ChildRole};
use std::process::{Child, Stdio};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::ShellExt;

pub const DEFAULT_PORT: u16 = 18887;
/// The MCP server's port (`MCP_PORT` default in `services/mcp-server`); the endpoint written into
/// client configs is `http://127.0.0.1:18890/mcp`.
pub const DEFAULT_MCP_PORT: u16 = 18890;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RuntimePorts {
    pub core: u16,
    pub mcp: u16,
}

impl Default for RuntimePorts {
    fn default() -> Self {
        Self {
            core: DEFAULT_PORT,
            mcp: DEFAULT_MCP_PORT,
        }
    }
}

pub fn parse_runtime_ports(
    core_port: Option<&str>,
    mcp_port: Option<&str>,
) -> Result<RuntimePorts, String> {
    fn parse(name: &str, value: Option<&str>, default: u16) -> Result<u16, String> {
        let Some(value) = value.filter(|value| !value.trim().is_empty()) else {
            return Ok(default);
        };
        let port = value
            .trim()
            .parse::<u16>()
            .map_err(|_| format!("{name} 必须是 1 到 65535 之间的端口。"))?;
        if port == 0 {
            return Err(format!("{name} 必须是 1 到 65535 之间的端口。"));
        }
        Ok(port)
    }

    let ports = RuntimePorts {
        core: parse("NOLTRI_CORE_PORT", core_port, DEFAULT_PORT)?,
        mcp: parse("MCP_PORT", mcp_port, DEFAULT_MCP_PORT)?,
    };
    if ports.core == ports.mcp {
        return Err("NOLTRI_CORE_PORT 与 MCP_PORT 必须使用不同端口。".to_owned());
    }
    Ok(ports)
}

pub fn resolve_runtime_ports() -> Result<RuntimePorts, String> {
    parse_runtime_ports(
        std::env::var("NOLTRI_CORE_PORT").ok().as_deref(),
        std::env::var("MCP_PORT").ok().as_deref(),
    )
}

/// How long the managed runtime gets to answer the health probes before it is declared failed.
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const PROBE_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Clone, Debug, PartialEq)]
pub enum CoreStatus {
    /// Probe still running / process not resolved yet.
    Starting,
    /// Explicit external opt-in, validated by authenticated Core and MCP identity probes.
    External,
    /// Dev run: the runtime belongs to the developer's terminal, not to this process.
    DevManual,
    /// We spawned the bundled runtime (Core + MCP) and both passed their identity probes.
    Managed,
    /// We spawned the bundled runtime but it never became healthy.
    Failed(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeMode {
    Unresolved,
    Managed,
    External,
    DevManual,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeDiagnosticStatus {
    Starting,
    Managed,
    External,
    DevManual,
    Stopping,
    Stopped,
    Failed,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeDiagnostics {
    pub app_pid: u32,
    pub generation: u64,
    pub mode: RuntimeMode,
    pub status: RuntimeDiagnosticStatus,
    pub children: Vec<ownership::ChildDiagnostics>,
    pub shutdown_confirmed: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeStopOutcome {
    Confirmed,
    KillFailed,
    TimedOut,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStopReport {
    pub outcome: RuntimeStopOutcome,
    pub shutdown_confirmed: bool,
    pub unconfirmed_children: usize,
}

/// One mutex serializes generation, child handles, readiness and connection publication.
/// OS kill/try_wait only target handles returned by this host's spawn.
#[derive(Default)]
pub struct CoreRuntimeHandle {
    state: Mutex<RuntimeState>,
    // Always lifecycle -> state; observation takes only state and never waits for lifecycle.
    lifecycle: Mutex<()>,
    model_update: Mutex<()>,
}
struct RuntimeState {
    closed: bool,
    status: Option<CoreStatus>,
    mode: RuntimeMode,
    connection: Option<RuntimeConnection>,
    ledger: ChildLedger<Child>,
}
impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            closed: false,
            status: None,
            mode: RuntimeMode::Unresolved,
            connection: None,
            ledger: ChildLedger::default(),
        }
    }
}
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(25);

impl ChildControl for Child {
    fn pid(&self) -> u32 {
        self.id()
    }
    fn kill(&mut self) -> Result<(), ()> {
        Child::kill(self).map_err(|_| ())
    }
    fn try_wait(&mut self) -> Result<Option<ChildExit>, ()> {
        Child::try_wait(self)
            .map(|status| {
                status.map(|status| {
                    #[cfg(unix)]
                    let signal = {
                        use std::os::unix::process::ExitStatusExt;
                        status.signal()
                    };
                    #[cfg(not(unix))]
                    let signal = None;
                    ChildExit {
                        code: status.code(),
                        signal,
                    }
                })
            })
            .map_err(|_| ())
    }
}

impl CoreRuntimeHandle {
    pub fn status(&self) -> CoreStatus {
        self.lock(&self.state)
            .status
            .clone()
            .unwrap_or(CoreStatus::Starting)
    }
    #[cfg(test)]
    fn set_connection(&self, connection: RuntimeConnection) {
        self.lock(&self.state).connection = Some(connection);
    }
    fn accept_connection(
        &self,
        generation: u64,
        connection: RuntimeConnection,
        accepted: CoreStatus,
    ) -> Result<(), String> {
        let mut state = self.lock(&self.state);
        if state.closed {
            return Err("runtime_host_closed".into());
        }
        Self::observe_locked(&mut state);
        if state.ledger.generation != generation
            || state.ledger.shutting_down
            || !matches!(state.status.as_ref(), None | Some(CoreStatus::Starting))
        {
            return Err("stale_runtime_session".into());
        }
        state.mode = match accepted {
            CoreStatus::Managed => RuntimeMode::Managed,
            CoreStatus::External => RuntimeMode::External,
            CoreStatus::DevManual => RuntimeMode::DevManual,
            _ => return Err("invalid_runtime_acceptance".into()),
        };
        state.connection = Some(connection);
        state.status = Some(accepted);
        Ok(())
    }
    pub fn connection_if_ready(&self) -> Result<RuntimeConnection, String> {
        let mut state = self.lock(&self.state);
        Self::observe_locked(&mut state);
        if state.closed
            || state.ledger.shutting_down
            || !matches!(
                state.status.as_ref(),
                Some(CoreStatus::Managed | CoreStatus::External | CoreStatus::DevManual)
            )
        {
            return Err("authenticated_runtime_not_ready".into());
        }
        state
            .connection
            .clone()
            .ok_or_else(|| "authenticated_runtime_not_ready".into())
    }
    pub fn wait_connection(&self) -> Result<RuntimeConnection, String> {
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while self.status() == CoreStatus::Starting && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        self.connection_if_ready()
    }
    pub fn begin_model_update(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.model_update
            .try_lock()
            .map_err(|_| "模型正在更新，请稍后再试。".to_owned())
    }
    fn set(&self, status: CoreStatus) {
        self.lock(&self.state).status = Some(status);
    }
    fn begin_session(&self) -> Result<u64, String> {
        let _lifecycle = self.lock(&self.lifecycle);
        let mut state = self.lock(&self.state);
        if state.closed {
            return Err("runtime_host_closed".into());
        }
        Self::observe_locked(&mut state);
        let generation = match state.ledger.begin_generation() {
            Ok(generation) => generation,
            Err(()) => {
                state.status = Some(CoreStatus::Failed(
                    "owned_runtime_shutdown_unconfirmed".into(),
                ));
                state.connection = None;
                return Err("owned_runtime_shutdown_unconfirmed".into());
            }
        };
        state.status = Some(CoreStatus::Starting);
        state.mode = RuntimeMode::Unresolved;
        state.connection = None;
        eprintln!(
            "noltri_runtime event=start appPid={} generation={generation}",
            std::process::id()
        );
        Ok(generation)
    }
    fn current_generation(&self, generation: u64) -> bool {
        let state = self.lock(&self.state);
        !state.closed && state.ledger.generation == generation && !state.ledger.shutting_down
    }
    fn observe_locked(state: &mut RuntimeState) {
        if state.ledger.observe() {
            state.status = Some(CoreStatus::Failed("owned_runtime_child_terminated".into()));
            state.connection = None;
            state.ledger.request_stop();
        }
    }
    fn poll_owned(&self) {
        Self::observe_locked(&mut self.lock(&self.state));
    }
    fn has_owned_generation(&self, generation: u64) -> bool {
        self.lock(&self.state)
            .ledger
            .diagnostics()
            .iter()
            .any(|child| {
                child.generation == generation && child.state != ownership::ChildState::Terminated
            })
    }
    fn fail_session(&self, generation: u64) {
        let _lifecycle = self.lock(&self.lifecycle);
        {
            let mut state = self.lock(&self.state);
            // The generation comparison and stop request share the lock. A stale worker cannot
            // pass a check and then stop a newer session between two independently locked calls.
            if state.ledger.generation != generation {
                return;
            }
            state.status = Some(CoreStatus::Failed("managed_runtime_unavailable".into()));
            state.connection = None;
            state.ledger.request_stop();
        }
        self.wait_for_shutdown();
    }
    /// Bounded stop: a successful kill request is only an acknowledgment. Retain each handle until
    /// try_wait observes exit, including on kill/wait failure, and refuse restart while unconfirmed.
    /// External/developer runtimes never enter the owned ledger and are never signaled.
    pub fn stop(&self) -> RuntimeStopReport {
        // Keep a newer session out of this bounded wait; its exits must be handled as its own.
        let _lifecycle = self.lock(&self.lifecycle);
        {
            let mut state = self.lock(&self.state);
            state.ledger.observe();
            state.connection = None;
            state.ledger.request_stop();
        }
        self.wait_for_shutdown()
    }
    /// Permanently close this host before stopping owned children. In-flight model updates may
    /// finish their wait, but can never create another generation or publish readiness afterward.
    pub fn shutdown(&self) -> RuntimeStopReport {
        let _lifecycle = self.lock(&self.lifecycle);
        {
            let mut state = self.lock(&self.state);
            state.closed = true;
            state.connection = None;
            state.ledger.observe();
            state.ledger.request_stop();
        }
        self.wait_for_shutdown()
    }
    fn spawn_owned(
        &self,
        generation: u64,
        role: ChildRole,
        spawn: impl FnOnce() -> std::io::Result<Child>,
    ) -> Result<(), String> {
        let mut state = self.lock(&self.state);
        if state.closed {
            return Err("runtime_host_closed".into());
        }
        Self::observe_locked(&mut state);
        if state.ledger.generation != generation
            || state.ledger.shutting_down
            || !matches!(state.status.as_ref(), None | Some(CoreStatus::Starting))
        {
            return Err("stale_runtime_session".into());
        }
        let child = spawn().map_err(|_| "runtime_child_spawn_failed")?;
        state.ledger.add(role, generation, child);
        Ok(())
    }
    fn wait_for_shutdown(&self) -> RuntimeStopReport {
        let report = wait_for_owned_shutdown(STOP_TIMEOUT, || {
            let mut state = self.lock(&self.state);
            state.ledger.observe();
            (state.ledger.unconfirmed(), state.ledger.kill_failed())
        });
        eprintln!(
            "noltri_runtime event=stop appPid={} generation={} outcome={:?} unconfirmedChildren={}",
            std::process::id(),
            self.lock(&self.state).ledger.generation,
            report.outcome,
            report.unconfirmed_children
        );
        report
    }
    pub fn diagnostics(&self) -> RuntimeDiagnostics {
        let mut state = self.lock(&self.state);
        Self::observe_locked(&mut state);
        let confirmed = state.ledger.unconfirmed() == 0;
        let status = if matches!(state.status, Some(CoreStatus::Failed(_))) {
            RuntimeDiagnosticStatus::Failed
        } else if state.ledger.shutting_down {
            if confirmed {
                RuntimeDiagnosticStatus::Stopped
            } else {
                RuntimeDiagnosticStatus::Stopping
            }
        } else {
            match state.status.as_ref() {
                Some(CoreStatus::Managed) => RuntimeDiagnosticStatus::Managed,
                Some(CoreStatus::External) => RuntimeDiagnosticStatus::External,
                Some(CoreStatus::DevManual) => RuntimeDiagnosticStatus::DevManual,
                _ => RuntimeDiagnosticStatus::Starting,
            }
        };
        RuntimeDiagnostics {
            app_pid: std::process::id(),
            generation: state.ledger.generation,
            mode: state.mode,
            status,
            children: state.ledger.diagnostics(),
            shutdown_confirmed: confirmed,
        }
    }
    fn lock<'a, T>(&self, mutex: &'a Mutex<T>) -> MutexGuard<'a, T> {
        mutex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Shared bounded driver keeps kill acknowledgment separate from observed exit. The callback
/// holds the state lock only for handle observation; no mutex is held while sleeping.
fn wait_for_owned_shutdown(
    timeout: Duration,
    mut observe: impl FnMut() -> (usize, bool),
) -> RuntimeStopReport {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let (unconfirmed, kill_failed) = observe();
        if unconfirmed == 0 || std::time::Instant::now() >= deadline {
            let outcome = if unconfirmed == 0 {
                RuntimeStopOutcome::Confirmed
            } else if kill_failed {
                RuntimeStopOutcome::KillFailed
            } else {
                RuntimeStopOutcome::TimedOut
            };
            return RuntimeStopReport {
                outcome,
                shutdown_confirmed: unconfirmed == 0,
                unconfirmed_children: unconfirmed,
            };
        }
        std::thread::sleep(
            CHILD_POLL_INTERVAL.min(deadline.saturating_duration_since(std::time::Instant::now())),
        );
    }
}

#[tauri::command]
pub fn get_runtime_diagnostics(
    runtime: tauri::State<'_, Arc<CoreRuntimeHandle>>,
) -> RuntimeDiagnostics {
    runtime.diagnostics()
}

#[derive(Clone)]
pub struct RuntimeConnection {
    pub api_base_url: String,
    pub api_token: String,
    pub mcp_endpoint: String,
}

#[derive(Debug, PartialEq)]
enum StartupPlan {
    Managed,
    External,
    DevManual,
}

fn startup_plan(
    external: bool,
    dev: bool,
    core_occupied: bool,
    mcp_occupied: bool,
) -> Result<StartupPlan, String> {
    if external {
        return Ok(StartupPlan::External);
    }
    if dev {
        return Ok(StartupPlan::DevManual);
    }
    if core_occupied || mcp_occupied {
        return Err("managed_runtime_ports_occupied".into());
    }
    Ok(StartupPlan::Managed)
}

fn connection_ports(connection: &RuntimeConnection, managed: bool) -> Result<RuntimePorts, String> {
    fn endpoint(value: &str, path: &str, managed: bool) -> Result<u16, String> {
        let url = tauri::Url::parse(value).map_err(|_| "invalid_runtime_endpoint")?;
        let local = url.host_str().is_some_and(|host| {
            host == "localhost"
                || host
                    .trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        if !local
            || !matches!(url.scheme(), "http" | "https")
            || (managed && url.scheme() != "http")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path().trim_end_matches('/') != path
        {
            return Err("authenticated_loopback_runtime_required".into());
        }
        url.port_or_known_default()
            .filter(|p| *p != 0)
            .ok_or_else(|| "invalid_runtime_endpoint".into())
    }
    crate::device_access::validate_token(&connection.api_token)?;
    let ports = RuntimePorts {
        core: endpoint(&connection.api_base_url, "", managed)?,
        mcp: endpoint(&connection.mcp_endpoint, "/mcp", managed)?,
    };
    if ports.core == ports.mcp {
        return Err("distinct_runtime_ports_required".into());
    }
    Ok(ports)
}

fn port_occupied(port: u16) -> bool {
    // A listener of any identity prevents managed startup. Never probe it with credentials.
    std::net::TcpListener::bind(std::net::SocketAddr::from(([127, 0, 0, 1], port))).is_err()
}

fn core_identity(health: &serde_json::Value, admin: &serde_json::Value) -> bool {
    health.get("productId").and_then(|v| v.as_str()) == Some("noltri-knowledge-core")
        && admin
            .pointer("/draft/revision")
            .and_then(|v| v.as_u64())
            .is_some()
        && admin.pointer("/draft/rules").is_some_and(|v| v.is_object())
        && admin
            .pointer("/applied/versionId")
            .and_then(|v| v.as_str())
            .is_some_and(|v| !v.is_empty())
        && admin
            .pointer("/applied/rules")
            .is_some_and(|v| v.is_object())
        && admin.get("versions").is_some_and(|v| v.is_array())
}
fn mcp_identity(value: &serde_json::Value) -> bool {
    value.get("server").and_then(|v| v.as_str()) == Some("noltri-knowledge")
        && value.get("status").and_then(|v| v.as_str()) == Some("ok")
        && value.get("endpoint").and_then(|v| v.as_str()) == Some("/mcp")
        && [
            "authRequired",
            "accessTokenConfigured",
            "knowledgeApiConfigured",
        ]
        .iter()
        .all(|key| value.get(key).and_then(|v| v.as_bool()) == Some(true))
}

fn mcp_initialize_identity(value: &serde_json::Value) -> bool {
    value.get("jsonrpc").and_then(|v| v.as_str()) == Some("2.0")
        && value.get("id").and_then(|v| v.as_u64()) == Some(1)
        && value.get("error").is_none()
        && value
            .pointer("/result/protocolVersion")
            .and_then(|v| v.as_str())
            == Some("2025-06-18")
        && value
            .pointer("/result/capabilities")
            .is_some_and(|v| v.is_object())
        && value
            .pointer("/result/serverInfo/name")
            .and_then(|v| v.as_str())
            == Some("noltri-knowledge")
        && value
            .pointer("/result/serverInfo/version")
            .and_then(|v| v.as_str())
            .is_some_and(|v| !v.is_empty())
}

async fn bounded_json(mut response: reqwest::Response) -> Option<serde_json::Value> {
    if response.status() != reqwest::StatusCode::OK {
        return None;
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if body.len() + chunk.len() > 2 * 1024 * 1024 {
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).ok()
}

fn authenticated_runtime(connection: &RuntimeConnection) -> bool {
    tauri::async_runtime::block_on(async {
        let Ok(client) = reqwest::Client::builder()
            .timeout(Duration::from_millis(900))
            .connect_timeout(Duration::from_millis(400))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
        else {
            return false;
        };
        let base = connection.api_base_url.trim_end_matches('/');
        let Ok(response) = client.get(format!("{base}/api/health")).send().await else {
            return false;
        };
        let Some(health) = bounded_json(response).await else {
            return false;
        };
        if health.get("productId").and_then(|v| v.as_str()) != Some("noltri-knowledge-core") {
            return false;
        }
        let admin_url = format!("{base}/api/admin/processing-rules");
        // An unauthenticated endpoint cannot establish that this device credential was accepted.
        let Ok(denied) = client.get(&admin_url).send().await else {
            return false;
        };
        if !matches!(denied.status().as_u16(), 401 | 403) {
            return false;
        }
        let Ok(response) = client
            .get(&admin_url)
            .bearer_auth(&connection.api_token)
            .send()
            .await
        else {
            return false;
        };
        let Some(admin) = bounded_json(response).await else {
            return false;
        };
        if !core_identity(&health, &admin) {
            return false;
        }
        let Ok(mut mcp) = tauri::Url::parse(&connection.mcp_endpoint) else {
            return false;
        };
        mcp.set_path("/healthz");
        let Ok(response) = client.get(mcp).send().await else {
            return false;
        };
        if !bounded_json(response)
            .await
            .is_some_and(|value| mcp_identity(&value))
        {
            return false;
        }
        // Initialize is protocol metadata only: never list/call tools or read library data.
        // The negative probe prevents a permissive endpoint from proving credential acceptance.
        let initialize = serde_json::json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": { "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": { "name": "noltri-desktop-readiness", "version": env!("CARGO_PKG_VERSION") } }
        });
        let request = || {
            client
                .post(&connection.mcp_endpoint)
                .header(
                    reqwest::header::ACCEPT,
                    "application/json, text/event-stream",
                )
                .json(&initialize)
        };
        let Ok(denied) = request().send().await else {
            return false;
        };
        if !matches!(denied.status().as_u16(), 401 | 403) {
            return false;
        }
        let Ok(response) = request().bearer_auth(&connection.api_token).send().await else {
            return false;
        };
        bounded_json(response)
            .await
            .is_some_and(|value| mcp_initialize_identity(&value))
    })
}

fn managed_auth_env(
    token: &str,
    directory: &std::path::Path,
    explicit_env: Option<&str>,
) -> (Vec<(&'static str, String)>, Vec<(&'static str, String)>) {
    let env_file = explicit_env
        .filter(|v| !v.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| directory.join(".env.local").to_string_lossy().into_owned());
    let core = vec![
        ("NOLTRI_DEV_TOKEN", token.to_owned()),
        ("NOLTRI_ACCESS_TOKEN", token.to_owned()),
        ("NOLTRI_DEV_REQUIRE_TOKEN", "true".into()),
        ("NOLTRI_ENV_FILE", env_file.clone()),
    ];
    let mcp = vec![
        ("NOLTRI_ACCESS_TOKEN", token.to_owned()),
        ("AUTH_REQUIRED", "true".into()),
        ("MCP_HOST", "127.0.0.1".into()),
        ("NOLTRI_ENV_FILE", env_file),
    ];
    (core, mcp)
}

/// Resolve the existing pinned shell sidecar, then use std's borrowed kill/try_wait interface.
/// Shell's CommandChild::kill(self) consumes even a failed handle, preventing honest retry.
fn spawn_script(
    app: &AppHandle,
    handle: &Arc<CoreRuntimeHandle>,
    script_name: &'static str,
    envs: &[(&str, String)],
    generation: u64,
) -> Result<(), String> {
    let role = match script_name {
        "core-server.mjs" => ChildRole::Core,
        "mcp-server.mjs" => ChildRole::Mcp,
        _ => return Err("unknown_runtime_child_role".into()),
    };
    let script = app
        .path()
        .resolve(format!("resources/{script_name}"), BaseDirectory::Resource)
        .map_err(|_| "runtime_script_unavailable")?;
    let mut command = app
        .shell()
        .sidecar("noltri-runtime")
        .map_err(|_| "runtime_sidecar_unavailable")?
        .args([script.to_string_lossy().to_string()]);
    for (key, value) in envs {
        command = command.env(key, value);
    }
    let mut command: std::process::Command = command.into();
    // Child output is discarded at the OS pipe boundary, never copied to native logs.
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    // Spawn and registration share the state lock with stop: no successful spawn can be missed.
    handle.spawn_owned(generation, role, || command.spawn())
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

/// Resolve a single isolated session. Managed mode owns both children; explicit external/dev mode owns neither.
pub fn start(app: AppHandle, handle: Arc<CoreRuntimeHandle>) {
    let generation = match handle.begin_session() {
        Ok(generation) => generation,
        Err(_) => return,
    };
    std::thread::spawn(move || {
        if start_session(&app, &handle, generation).is_err() {
            handle.fail_session(generation);
        }
        // Observe only our own retained Child handles. No process inventory or PID-based kill.
        while handle.has_owned_generation(generation) {
            handle.poll_owned();
            std::thread::sleep(CHILD_POLL_INTERVAL);
        }
    });
}

fn start_session(
    app: &AppHandle,
    handle: &Arc<CoreRuntimeHandle>,
    generation: u64,
) -> Result<(), String> {
    let acceptance = cfg!(feature = "native-capture-acceptance");
    let external = std::env::var("NOLTRI_USE_EXTERNAL_RUNTIME").ok().as_deref() == Some("1");
    let dev = tauri::is_dev() || acceptance;
    let directory = crate::settings::directory(
        app.path()
            .app_config_dir()
            .map_err(|_| "settings_directory_unavailable")?,
    );
    let settings = crate::settings::load_authenticated(&directory, !external && !dev)?;
    let connection = RuntimeConnection {
        api_base_url: settings.api_base_url,
        api_token: settings.api_token,
        mcp_endpoint: settings.mcp_endpoint,
    };
    let ports = connection_ports(&connection, !external && !dev)?;
    let plan = if acceptance {
        StartupPlan::DevManual
    } else {
        startup_plan(
            external,
            dev,
            port_occupied(ports.core),
            port_occupied(ports.mcp),
        )?
    };
    {
        let mut state = handle.lock(&handle.state);
        if state.ledger.generation != generation || state.ledger.shutting_down {
            return Err("stale_runtime_session".into());
        }
        state.mode = match plan {
            StartupPlan::Managed => RuntimeMode::Managed,
            StartupPlan::External => RuntimeMode::External,
            StartupPlan::DevManual => RuntimeMode::DevManual,
        };
    }
    if plan != StartupPlan::Managed {
        if !acceptance && !authenticated_runtime(&connection) {
            return Err("external_runtime_authentication_failed".into());
        }
        return handle.accept_connection(
            generation,
            connection,
            if plan == StartupPlan::External {
                CoreStatus::External
            } else {
                CoreStatus::DevManual
            },
        );
    }
    let default_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "runtime_directory_unavailable")?;
    let (data_dir, mut core_envs) =
        runtime_storage_env(default_data_dir, |key| std::env::var(key).ok());
    std::fs::create_dir_all(&data_dir).map_err(|_| "runtime_directory_unavailable")?;
    let (core_auth, mut mcp_envs) = managed_auth_env(
        &connection.api_token,
        &directory,
        std::env::var("NOLTRI_ENV_FILE").ok().as_deref(),
    );
    core_envs.extend(core_auth);
    core_envs.extend(model_env(&settings.models));
    core_envs.push(("PORT", ports.core.to_string()));
    mcp_envs.extend([
        ("KNOWLEDGE_API_URL", connection.api_base_url.clone()),
        ("NOLTRI_DATA_DIR", data_dir.to_string_lossy().into_owned()),
        ("MCP_PORT", ports.mcp.to_string()),
    ]);
    spawn_script(app, handle, "core-server.mjs", &core_envs, generation)?;
    spawn_script(app, handle, "mcp-server.mjs", &mcp_envs, generation)?;
    let deadline = std::time::Instant::now() + READY_TIMEOUT;
    while std::time::Instant::now() < deadline {
        handle.poll_owned();
        if !handle.current_generation(generation)
            || matches!(handle.status(), CoreStatus::Failed(_))
        {
            return Err("runtime_child_terminated".into());
        }
        if authenticated_runtime(&connection) {
            return handle.accept_connection(generation, connection, CoreStatus::Managed);
        }
        std::thread::sleep(PROBE_INTERVAL);
    }
    Err("managed_runtime_readiness_timeout".into())
}

/// Always set the driver explicitly so an empty selection cannot fall back to inherited env values.
fn model_env(models: &crate::settings::ModelSettings) -> Vec<(&'static str, String)> {
    let Some((provider, model)) = models.active() else {
        return vec![
            ("AI_PROVIDER", "disabled".to_owned()),
            ("AI_API_KEY", String::new()),
            ("AI_BASE_URL", String::new()),
            ("AI_CHAT_MODEL", String::new()),
            ("AI_IMAGE_RECOGNITION_MODEL", String::new()),
            ("AI_MODEL_CONTEXT_WINDOW", String::new()),
            ("AI_MODEL_MAX_TOKENS", String::new()),
            ("AI_EMBEDDINGS_ENABLED", "false".to_owned()),
        ];
    };
    let protocol = match provider.protocol {
        crate::settings::ProviderProtocol::OpenAiCompletions => "openai-completions",
        crate::settings::ProviderProtocol::OpenAiResponses => "openai-responses",
        crate::settings::ProviderProtocol::AnthropicMessages => "anthropic-messages",
    };
    vec![
        ("AI_PROVIDER", "openai".to_owned()),
        ("AI_PROTOCOL", protocol.to_owned()),
        ("AI_BASE_URL", provider.base_url.clone()),
        ("AI_API_KEY", provider.api_key.clone()),
        ("AI_CHAT_MODEL", model.id.clone()),
        (
            "AI_IMAGE_RECOGNITION_MODEL",
            if model.input.image
                && matches!(
                    provider.protocol,
                    crate::settings::ProviderProtocol::OpenAiCompletions
                )
            {
                model.id.clone()
            } else {
                String::new()
            },
        ),
        (
            "AI_MODEL_CONTEXT_WINDOW",
            model
                .context_window
                .map(|value| value.to_string())
                .unwrap_or_default(),
        ),
        (
            "AI_MODEL_MAX_TOKENS",
            model
                .max_tokens
                .map(|value| value.to_string())
                .unwrap_or_default(),
        ),
        ("AI_EMBEDDINGS_ENABLED", "false".to_owned()),
    ]
}

/// Apply settings only to children owned by this app. Wait for the old listener to close before
/// probing again, otherwise startup could mistake its own dying child for an external runtime.
pub fn apply_models(app: AppHandle, handle: Arc<CoreRuntimeHandle>) -> Result<bool, String> {
    let initial_deadline = std::time::Instant::now() + READY_TIMEOUT;
    while handle.status() == CoreStatus::Starting && std::time::Instant::now() < initial_deadline {
        std::thread::sleep(PROBE_INTERVAL);
    }
    if matches!(
        handle.status(),
        CoreStatus::External | CoreStatus::DevManual | CoreStatus::Starting
    ) {
        return Ok(false);
    }
    let ports = connection_ports(&handle.connection_if_ready()?, true)?;
    let owns_mcp = handle.diagnostics().children.iter().any(|child| {
        child.role == ChildRole::Mcp && child.state != ownership::ChildState::Terminated
    });
    handle.set(CoreStatus::Starting);
    let stopped = handle.stop();
    if !stopped.shutdown_confirmed {
        let reason = "模型已保存，但旧服务退出尚未确认，请稍后重试。".to_owned();
        handle.set(CoreStatus::Failed(
            "owned_runtime_shutdown_unconfirmed".into(),
        ));
        return Err(reason);
    }
    let deadline = std::time::Instant::now() + READY_TIMEOUT;
    while port_occupied(ports.core) || (owns_mcp && port_occupied(ports.mcp)) {
        if std::time::Instant::now() >= deadline {
            let reason = "模型已保存，但旧服务未能退出，请重新打开应用。".to_owned();
            handle.set(CoreStatus::Failed(reason.clone()));
            return Err(reason);
        }
        std::thread::sleep(PROBE_INTERVAL);
    }
    start(app, handle.clone());
    while std::time::Instant::now() < deadline + READY_TIMEOUT {
        match handle.status() {
            CoreStatus::Managed => return Ok(true),
            CoreStatus::Failed(reason) => {
                return Err(format!("模型已保存，服务重启失败：{reason}"))
            }
            CoreStatus::External | CoreStatus::DevManual => return Ok(false),
            CoreStatus::Starting => std::thread::sleep(PROBE_INTERVAL),
        }
    }
    Err("模型已保存，服务仍在启动，请稍后检查连接。".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_ports_default_validate_and_reject_invalid_or_conflicting_values() {
        assert_eq!(parse_runtime_ports(None, None), Ok(RuntimePorts::default()));
        assert_eq!(
            parse_runtime_ports(Some("18787"), Some("18790")),
            Ok(RuntimePorts {
                core: 18787,
                mcp: 18790,
            })
        );
        assert!(parse_runtime_ports(Some("0"), None).is_err());
        assert!(parse_runtime_ports(None, Some("65536")).is_err());
        assert!(parse_runtime_ports(Some("nope"), None).is_err());
        assert!(parse_runtime_ports(Some("18787"), Some("18787")).is_err());
    }

    #[test]
    fn stop_without_a_child_is_a_no_op() {
        let handle = CoreRuntimeHandle::default();
        handle.stop();
        assert_eq!(handle.status(), CoreStatus::Starting);
    }

    #[test]
    fn switching_selected_models_changes_runtime_env_and_serializes_updates() {
        use crate::settings::{
            ModelInputTypes, ModelSettings, ProviderConfig, ProviderModel, ProviderProtocol,
        };
        let provider = |api_key: &str| ProviderConfig {
            id: "deepseek".into(),
            name: "DeepSeek".into(),
            protocol: ProviderProtocol::OpenAiCompletions,
            base_url: "https://api.deepseek.com".into(),
            api_key: api_key.into(),
            models: vec![
                ProviderModel {
                    id: "deepseek-chat".into(),
                    name: "Flash".into(),
                    context_window: Some(64000),
                    max_tokens: Some(8192),
                    input: ModelInputTypes {
                        text: true,
                        image: false,
                    },
                },
                ProviderModel {
                    id: "deepseek-v4-pro".into(),
                    name: "Pro".into(),
                    context_window: Some(128000),
                    max_tokens: Some(8192),
                    input: ModelInputTypes {
                        text: true,
                        image: false,
                    },
                },
            ],
        };
        let mut models = ModelSettings {
            providers: vec![provider("test-key")],
            active_provider_id: Some("deepseek".into()),
            active_model_id: Some("deepseek-chat".into()),
        };
        let initial = model_env(&models);
        assert!(initial.contains(&("AI_CHAT_MODEL", "deepseek-chat".into())));
        assert!(initial.contains(&("AI_MODEL_MAX_TOKENS", "8192".into())));
        assert!(initial.contains(&("AI_MODEL_CONTEXT_WINDOW", "64000".into())));
        models.providers = vec![provider("updated-key")];
        models.active_model_id = Some("deepseek-v4-pro".into());
        let envs = model_env(&models);
        assert!(envs.contains(&("AI_PROVIDER", "openai".into())));
        assert!(envs.contains(&("AI_CHAT_MODEL", "deepseek-v4-pro".into())));
        assert!(envs.contains(&("AI_API_KEY", "updated-key".into())));
        assert!(envs.contains(&("AI_EMBEDDINGS_ENABLED", "false".into())));
        let disabled = model_env(&ModelSettings::default());
        assert!(disabled.contains(&("AI_PROVIDER", "disabled".into())));
        let runtime = CoreRuntimeHandle::default();
        let guard = runtime.begin_model_update().unwrap();
        assert!(runtime.begin_model_update().is_err());
        drop(guard);
        assert!(runtime.begin_model_update().is_ok());
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

#[cfg(test)]
mod managed_profile_tests {
    use super::*;

    // Read the public API's source-of-truth identity so a synthetic fixture cannot mask drift.
    fn core_product_id_fixture() -> &'static str {
        include_str!("../../../../packages/schema/src/api.ts")
            .split("export const CORE_PRODUCT_ID = '")
            .nth(1)
            .and_then(|value| value.split_once('\'').map(|(id, _)| id))
            .expect("schema exports the Core product identity")
    }

    #[test]
    fn managed_profile_rejects_obsolete_core_product_identity() {
        let admin = serde_json::json!({"draft":{"revision":1,"rules":{}},"applied":{"versionId":"v1","rules":{}},"versions":[]});
        assert!(!core_identity(
            &serde_json::json!({"productId":"noltri"}),
            &admin
        ));
        assert!(!core_identity(
            &serde_json::json!({"productId":"unknown"}),
            &admin
        ));
    }
    #[test]
    fn managed_profile_never_implicitly_attaches_or_mixes_services() {
        assert_eq!(
            startup_plan(false, false, false, false),
            Ok(StartupPlan::Managed)
        );
        for occupied in [(true, false), (false, true), (true, true)] {
            assert!(startup_plan(false, false, occupied.0, occupied.1).is_err());
        }
        assert_eq!(
            startup_plan(true, false, true, true),
            Ok(StartupPlan::External)
        );
        assert_eq!(
            startup_plan(false, true, true, true),
            Ok(StartupPlan::DevManual)
        );
        assert_eq!(
            RuntimePorts::default(),
            RuntimePorts {
                core: 18887,
                mcp: 18890
            }
        );
    }
    #[test]
    fn managed_profile_requires_exact_authenticated_identity() {
        let health = serde_json::json!({"productId":core_product_id_fixture()});
        assert_eq!(core_product_id_fixture(), "noltri-knowledge-core");
        let admin = serde_json::json!({"draft":{"revision":1,"rules":{}},"applied":{"versionId":"synthetic-version","rules":{}},"versions":[]});
        assert!(core_identity(&health, &admin));
        assert!(!core_identity(
            &serde_json::json!({"productId":"not-noltri"}),
            &admin
        ));
        assert!(!core_identity(
            &health,
            &serde_json::json!({"error":"noltri"})
        ));
        let mcp = serde_json::json!({"status":"ok","server":"noltri-knowledge","endpoint":"/mcp","authRequired":true,"accessTokenConfigured":true,"knowledgeApiConfigured":true});
        assert!(mcp_identity(&mcp));
        for key in [
            "authRequired",
            "accessTokenConfigured",
            "knowledgeApiConfigured",
        ] {
            let mut bad = mcp.clone();
            bad[key] = serde_json::json!(false);
            assert!(!mcp_identity(&bad));
        }
    }
    #[test]
    fn managed_profile_child_environments_share_token_and_explicit_profile_file() {
        let (core, mcp) = managed_auth_env(
            "synthetic-device-token",
            std::path::Path::new("/synthetic/profile"),
            None,
        );
        let value = |envs: &Vec<(&str, String)>, key: &str| {
            envs.iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone())
        };
        assert!(value(&core, "NOLTRI_DEV_TOKEN") == value(&mcp, "NOLTRI_ACCESS_TOKEN"));
        assert!(value(&core, "NOLTRI_ACCESS_TOKEN") == value(&core, "NOLTRI_DEV_TOKEN"));
        assert_eq!(
            value(&core, "NOLTRI_DEV_REQUIRE_TOKEN").as_deref(),
            Some("true")
        );
        assert_eq!(value(&mcp, "AUTH_REQUIRED").as_deref(), Some("true"));
        assert_eq!(
            value(&core, "NOLTRI_ENV_FILE").as_deref(),
            Some("/synthetic/profile/.env.local")
        );
        assert_eq!(
            value(&core, "NOLTRI_ENV_FILE"),
            value(&mcp, "NOLTRI_ENV_FILE")
        );
        let (explicit, _) = managed_auth_env(
            "synthetic-device-token",
            std::path::Path::new("/synthetic/profile"),
            Some("/explicit/fixture.env"),
        );
        assert_eq!(
            value(&explicit, "NOLTRI_ENV_FILE").as_deref(),
            Some("/explicit/fixture.env")
        );
    }
    #[test]
    fn managed_profile_endpoints_reject_remote_credentials_and_invalid_paths() {
        let connection = |url: &str| RuntimeConnection {
            api_base_url: url.into(),
            api_token: "synthetic-token".into(),
            mcp_endpoint: "http://127.0.0.1:18890/mcp".into(),
        };
        for url in [
            "https://example.com",
            "http://user@localhost:18887",
            "http://127.0.0.1:18887/api",
            "http://127.0.0.1:18887?query=x",
        ] {
            assert!(connection_ports(&connection(url), true).is_err());
        }
        assert_eq!(
            connection_ports(&connection("http://127.0.0.1:19999"), true)
                .unwrap()
                .core,
            19999
        );
    }
    fn handshake_fixture(
        mcp: bool,
        require_auth: bool,
        accept_token: bool,
        reply: &'static str,
    ) -> (
        u16,
        Arc<std::sync::atomic::AtomicBool>,
        Arc<std::sync::atomic::AtomicUsize>,
        std::thread::JoinHandle<()>,
    ) {
        use std::io::{Read, Write};
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let authenticated = Arc::new(AtomicUsize::new(0));
        let count = authenticated.clone();
        let thread = std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = Vec::new();
                let mut chunk = [0u8; 4096];
                while bytes.len() < 16384 {
                    let size = stream.read(&mut chunk).unwrap_or(0);
                    if size == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&chunk[..size]);
                    if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_ascii_lowercase();
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                line.strip_prefix("content-length:")
                                    .and_then(|v| v.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let request = String::from_utf8_lossy(&bytes);
                let lower = request.to_ascii_lowercase();
                let has_token = lower.contains("authorization: bearer synthetic-device-token");
                if has_token {
                    count.fetch_add(1, Ordering::SeqCst);
                }
                let (status, body) = if mcp && lower.starts_with("get /healthz ") {
                    (200, serde_json::json!({"status":"ok","server":"noltri-knowledge","endpoint":"/mcp","authRequired":true,"accessTokenConfigured":true,"knowledgeApiConfigured":true}).to_string())
                } else if mcp {
                    let rpc = request
                        .split_once("\r\n\r\n")
                        .and_then(|(_, body)| serde_json::from_str::<serde_json::Value>(body).ok());
                    if !lower.starts_with("post /mcp ")
                        || !lower.contains("accept: application/json, text/event-stream")
                        || !rpc.as_ref().is_some_and(|v| {
                            v.get("method").and_then(|v| v.as_str()) == Some("initialize")
                                && v.pointer("/params/protocolVersion")
                                    .and_then(|v| v.as_str())
                                    == Some("2025-06-18")
                        })
                    {
                        (400, "{}".into())
                    } else if require_auth && !(has_token && accept_token) {
                        (401, "{}".into())
                    } else {
                        let mut body = serde_json::json!({"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{"name":"noltri-knowledge","version":"0.1.0"}}});
                        match reply {
                            "error" => {
                                body = serde_json::json!({"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"synthetic"}})
                            }
                            "wrong-id" => body["id"] = serde_json::json!(9),
                            "wrong-protocol" => {
                                body["result"]["protocolVersion"] = serde_json::json!("unknown")
                            }
                            "wrong-server" => {
                                body["result"]["serverInfo"]["name"] = serde_json::json!("other")
                            }
                            "missing-capabilities" => {
                                body["result"]
                                    .as_object_mut()
                                    .unwrap()
                                    .remove("capabilities");
                            }
                            _ => {}
                        }
                        (
                            200,
                            if reply == "malformed" {
                                "not JSON".into()
                            } else if reply == "oversized" {
                                " ".repeat(2 * 1024 * 1024 + 1)
                            } else {
                                body.to_string()
                            },
                        )
                    }
                } else if lower.starts_with("get /api/health ") {
                    (
                        200,
                        serde_json::json!({"productId":core_product_id_fixture()}).to_string(),
                    )
                } else if !require_auth || (has_token && accept_token) {
                    (200, serde_json::json!({"draft":{"revision":1,"rules":{}},"applied":{"versionId":"synthetic-version","rules":{}},"versions":[]}).to_string())
                } else {
                    (401, "{}".into())
                };
                let response = format!("HTTP/1.1 {status} Result\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (port, stopped, authenticated, thread)
    }

    fn assert_handshake(
        core_require: bool,
        core_accept: bool,
        mcp_require: bool,
        mcp_accept: bool,
        reply: &'static str,
        expected: bool,
    ) {
        use std::sync::atomic::Ordering;
        let core = handshake_fixture(false, core_require, core_accept, "valid");
        let mcp = handshake_fixture(true, mcp_require, mcp_accept, reply);
        let connection = RuntimeConnection {
            api_base_url: format!("http://127.0.0.1:{}", core.0),
            api_token: "synthetic-device-token".into(),
            mcp_endpoint: format!("http://127.0.0.1:{}/mcp", mcp.0),
        };
        let accepted = authenticated_runtime(&connection);
        core.1.store(true, Ordering::SeqCst);
        mcp.1.store(true, Ordering::SeqCst);
        core.3.join().unwrap();
        mcp.3.join().unwrap();
        assert_eq!(
            accepted, expected,
            "readiness outcome for synthetic {reply} response"
        );
        if core_require && core_accept {
            assert_eq!(
                core.2.load(Ordering::SeqCst),
                1,
                "Core credential probe must execute"
            );
        }
        if core_require && core_accept && mcp_require {
            assert_eq!(
                mcp.2.load(Ordering::SeqCst),
                1,
                "MCP must evaluate this credential through initialize"
            );
        }
        if !core_require {
            assert_eq!(core.2.load(Ordering::SeqCst), 0);
        }
    }

    #[test]
    fn managed_profile_owned_loopback_auth_handshake_rejects_missing_or_wrong_auth() {
        assert_handshake(true, true, true, true, "valid", true);
        assert_handshake(false, true, true, true, "valid", false);
        assert_handshake(true, false, true, true, "valid", false);
    }
    #[test]
    fn managed_profile_mcp_credential_mismatch_cannot_publish_ready() {
        assert_handshake(true, true, true, false, "valid", false);
    }
    #[test]
    fn managed_profile_mcp_accepting_missing_credential_is_rejected() {
        assert_handshake(true, true, false, true, "valid", false);
    }
    #[test]
    fn managed_profile_mcp_rpc_error_is_rejected() {
        assert_handshake(true, true, true, true, "error", false);
    }
    #[test]
    fn managed_profile_mcp_malformed_json_is_rejected() {
        assert_handshake(true, true, true, true, "malformed", false);
    }
    #[test]
    fn managed_profile_mcp_wrong_response_id_is_rejected() {
        assert_handshake(true, true, true, true, "wrong-id", false);
    }
    #[test]
    fn managed_profile_mcp_unknown_protocol_is_rejected() {
        assert_handshake(true, true, true, true, "wrong-protocol", false);
    }
    #[test]
    fn managed_profile_mcp_wrong_server_is_rejected() {
        assert_handshake(true, true, true, true, "wrong-server", false);
    }
    #[test]
    fn managed_profile_mcp_missing_result_shape_is_rejected() {
        assert_handshake(true, true, true, true, "missing-capabilities", false);
    }
    #[test]
    fn managed_profile_mcp_oversized_body_is_rejected() {
        assert_handshake(true, true, true, true, "oversized", false);
    }
    #[test]
    fn managed_profile_settings_are_blocked_until_runtime_and_connection_are_accepted() {
        let handle = CoreRuntimeHandle::default();
        assert!(handle.connection_if_ready().is_err());
        handle.set(CoreStatus::Failed("synthetic failure".into()));
        assert!(handle.connection_if_ready().is_err());
        handle.set(CoreStatus::Managed);
        assert!(handle.connection_if_ready().is_err());
        handle.set_connection(RuntimeConnection {
            api_base_url: "http://127.0.0.1:18887".into(),
            api_token: "synthetic-device-token".into(),
            mcp_endpoint: "http://127.0.0.1:18890/mcp".into(),
        });
        assert!(handle.connection_if_ready().is_ok());
        handle.set(CoreStatus::Starting);
        assert!(handle.connection_if_ready().is_err());
    }
    #[test]
    fn managed_profile_stale_or_failed_generation_cannot_publish_ready_connection() {
        let handle = CoreRuntimeHandle::default();
        let connection = || RuntimeConnection {
            api_base_url: "http://127.0.0.1:18887".into(),
            api_token: "synthetic-token".into(),
            mcp_endpoint: "http://127.0.0.1:18890/mcp".into(),
        };
        assert!(handle
            .accept_connection(1, connection(), CoreStatus::Managed)
            .is_err());
        handle.set(CoreStatus::Failed("synthetic".into()));
        assert!(handle
            .accept_connection(0, connection(), CoreStatus::Managed)
            .is_err());
        handle.set(CoreStatus::Starting);
        assert!(handle
            .accept_connection(0, connection(), CoreStatus::Managed)
            .is_ok());
        handle.stop();
        handle.set(CoreStatus::Starting);
        assert!(handle
            .accept_connection(0, connection(), CoreStatus::Managed)
            .is_err());
    }
}

#[cfg(test)]
mod image_runtime_env_tests {
    use super::*;
    use crate::settings::{
        ModelInputTypes, ModelSettings, ProviderConfig, ProviderModel, ProviderProtocol,
    };
    fn selected(protocol: ProviderProtocol, image: bool) -> ModelSettings {
        ModelSettings {
            providers: vec![ProviderConfig {
                id: "synthetic".into(),
                name: "Synthetic".into(),
                protocol,
                base_url: "https://example.invalid".into(),
                api_key: "synthetic-only".into(),
                models: vec![ProviderModel {
                    id: "explicit-image-model".into(),
                    name: "Synthetic".into(),
                    context_window: None,
                    max_tokens: None,
                    input: ModelInputTypes { text: true, image },
                }],
            }],
            active_provider_id: Some("synthetic".into()),
            active_model_id: Some("explicit-image-model".into()),
        }
    }
    #[test]
    fn selected_supported_image_model_reaches_core_recognition_configuration() {
        let env = model_env(&selected(ProviderProtocol::OpenAiCompletions, true));
        assert!(env.contains(&("AI_IMAGE_RECOGNITION_MODEL", "explicit-image-model".into())));
    }
    #[test]
    fn text_only_and_disabled_models_override_stale_image_configuration() {
        for settings in [
            selected(ProviderProtocol::OpenAiCompletions, false),
            ModelSettings::default(),
        ] {
            assert!(model_env(&settings).contains(&("AI_IMAGE_RECOGNITION_MODEL", String::new())));
        }
    }
    #[test]
    fn unsupported_image_protocols_cannot_inherit_an_enabled_recognition_model() {
        for protocol in [
            ProviderProtocol::OpenAiResponses,
            ProviderProtocol::AnthropicMessages,
        ] {
            assert!(model_env(&selected(protocol, true))
                .contains(&("AI_IMAGE_RECOGNITION_MODEL", String::new())));
        }
    }
}

#[cfg(test)]
mod owned_runtime_regression_tests {
    use super::*;

    // Removing stop's connection invalidation must make this fail.
    #[test]
    fn owned_stop_revokes_a_previously_accepted_connection() {
        let handle = CoreRuntimeHandle::default();
        handle.set(CoreStatus::Managed);
        handle.set_connection(RuntimeConnection {
            api_base_url: "http://127.0.0.1:18887".into(),
            api_token: "synthetic-stop-token".into(),
            mcp_endpoint: "http://127.0.0.1:18890/mcp".into(),
        });
        assert!(handle.connection_if_ready().is_ok());
        handle.stop();
        assert!(
            handle.connection_if_ready().is_err(),
            "stopped session must not remain authenticated-ready"
        );
    }
}

#[cfg(test)]
mod owned_diagnostics_tests {
    use super::*;
    // A raw CoreStatus::Failed string or connection serialization would expose private data.
    #[test]
    fn owned_diagnostics_use_actual_self_pid_and_finite_redacted_status() {
        let handle = CoreRuntimeHandle::default();
        handle.set_connection(RuntimeConnection {
            api_base_url: "http://secret.invalid/private".into(),
            api_token: "PRIVATE_TOKEN_SENTINEL".into(),
            mcp_endpoint: "http://secret.invalid/mcp".into(),
        });
        handle.set(CoreStatus::Failed("PRIVATE_ERROR_SENTINEL/path".into()));
        let json = serde_json::to_value(handle.diagnostics()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "appPid": std::process::id(), "generation": 0,
            "mode": "unresolved", "status": "failed", "children": [], "shutdownConfirmed": true })
        );
    }
    // External/dev acceptance must never fabricate child ownership.
    #[test]
    fn owned_external_and_developer_sessions_have_no_owned_children() {
        for (status, mode) in [
            (CoreStatus::External, "external"),
            (CoreStatus::DevManual, "devManual"),
        ] {
            let handle = CoreRuntimeHandle::default();
            handle
                .accept_connection(
                    0,
                    RuntimeConnection {
                        api_base_url: "http://127.0.0.1:18887".into(),
                        api_token: "synthetic-only".into(),
                        mcp_endpoint: "http://127.0.0.1:18890/mcp".into(),
                    },
                    status,
                )
                .unwrap();
            let value = serde_json::to_value(handle.diagnostics()).unwrap();
            assert_eq!(value["mode"], mode);
            assert_eq!(value["children"], serde_json::json!([]));
            let stopped = handle.stop();
            assert_eq!(stopped.outcome, RuntimeStopOutcome::Confirmed);
            assert!(stopped.shutdown_confirmed);
        }
    }
}

#[cfg(all(test, unix))]
mod owned_child_integration_tests {
    use super::*;

    struct TestRuntime(CoreRuntimeHandle);
    impl Drop for TestRuntime {
        fn drop(&mut self) {
            self.0.stop();
        }
    }
    fn child(command: &str, args: &[&str]) -> Child {
        std::process::Command::new(command)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn only synthetic own child")
    }
    fn register(handle: &CoreRuntimeHandle, role: ChildRole, generation: u64, child: Child) -> u32 {
        let pid = child.id();
        handle
            .lock(&handle.state)
            .ledger
            .add(role, generation, child);
        pid
    }
    fn wait_for_exit(handle: &CoreRuntimeHandle, pid: u32) -> RuntimeDiagnostics {
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let diagnostics = handle.diagnostics();
            if diagnostics
                .children
                .iter()
                .any(|child| child.pid == pid && child.state == ownership::ChildState::Terminated)
            {
                return diagnostics;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "synthetic own exit must be observed within two seconds"
            );
            std::thread::sleep(CHILD_POLL_INTERVAL);
        }
    }
    // Dropping exit status or treating any exit as code zero loses this real owned-child evidence.
    #[test]
    fn owned_actual_exit_records_spawn_pid_and_exit_code_before_failure_cleanup() {
        let test = TestRuntime(CoreRuntimeHandle::default());
        let generation = test.0.begin_session().unwrap();
        let pid = register(
            &test.0,
            ChildRole::Core,
            generation,
            child("/bin/sh", &["-c", "exit 23"]),
        );
        let diagnostics = wait_for_exit(&test.0, pid);
        assert_eq!(diagnostics.children[0].pid, pid);
        assert_eq!(diagnostics.children[0].generation, generation);
        assert_eq!(diagnostics.children[0].exit_code, Some(23));
        assert_eq!(diagnostics.children[0].exit_signal, None);
        assert_eq!(diagnostics.status, RuntimeDiagnosticStatus::Failed);
        assert!(diagnostics.shutdown_confirmed);
    }
    // An acknowledgment alone cannot satisfy the observed signal and shutdown assertions.
    #[test]
    fn owned_actual_stop_confirms_only_after_both_children_are_reaped() {
        let test = TestRuntime(CoreRuntimeHandle::default());
        let generation = test.0.begin_session().unwrap();
        let core = register(
            &test.0,
            ChildRole::Core,
            generation,
            child("/bin/sleep", &["30"]),
        );
        let mcp = register(
            &test.0,
            ChildRole::Mcp,
            generation,
            child("/bin/sleep", &["30"]),
        );
        let report = test.0.stop();
        assert_eq!(report.outcome, RuntimeStopOutcome::Confirmed);
        assert!(report.shutdown_confirmed);
        assert_eq!(report.unconfirmed_children, 0);
        let diagnostics = test.0.diagnostics();
        assert_eq!(diagnostics.status, RuntimeDiagnosticStatus::Stopped);
        assert_eq!(
            diagnostics
                .children
                .iter()
                .map(|child| child.pid)
                .collect::<Vec<_>>(),
            vec![core, mcp]
        );
        let value = serde_json::to_value(&diagnostics).unwrap();
        assert_eq!(
            value["children"],
            serde_json::json!([
                { "role": "core", "pid": core, "generation": generation,
                  "state": "terminated", "exitSignal": 9, "killOutcome": "accepted" },
                { "role": "mcp", "pid": mcp, "generation": generation,
                  "state": "terminated", "exitSignal": 9, "killOutcome": "accepted" }
            ])
        );
        for child in diagnostics.children {
            assert_eq!(child.state, ownership::ChildState::Terminated);
            assert_eq!(child.kill_outcome, Some(ownership::KillOutcome::Accepted));
            assert_eq!(child.exit_signal, Some(9));
            assert_eq!(child.exit_code, None);
        }
    }
    // Ignoring a current child's exit would leave its owned sibling running indefinitely.
    #[test]
    fn owned_current_child_exit_stops_and_reaps_its_sibling() {
        let test = TestRuntime(CoreRuntimeHandle::default());
        let generation = test.0.begin_session().unwrap();
        let core = register(
            &test.0,
            ChildRole::Core,
            generation,
            child("/bin/sleep", &["30"]),
        );
        let mcp = register(
            &test.0,
            ChildRole::Mcp,
            generation,
            child("/bin/sh", &["-c", "exit 31"]),
        );
        wait_for_exit(&test.0, mcp);
        let diagnostics = wait_for_exit(&test.0, core);
        assert!(diagnostics.shutdown_confirmed);
        assert_eq!(diagnostics.status, RuntimeDiagnosticStatus::Failed);
        assert_eq!(diagnostics.children[0].exit_signal, Some(9));
        assert_eq!(
            diagnostics.children[0].kill_outcome,
            Some(ownership::KillOutcome::Accepted)
        );
        assert_eq!(diagnostics.children[1].exit_code, Some(31));
        assert_eq!(diagnostics.children[1].kill_outcome, None);
    }

    // A stale startup worker must not signal the live child of the replacement session.
    #[test]
    fn owned_stale_worker_failure_never_kills_new_generation() {
        let test = TestRuntime(CoreRuntimeHandle::default());
        let old_generation = test.0.begin_session().unwrap();
        let old_pid = register(
            &test.0,
            ChildRole::Core,
            old_generation,
            child("/bin/sh", &["-c", "exit 17"]),
        );
        wait_for_exit(&test.0, old_pid);
        let generation = test.0.begin_session().unwrap();
        let pid = register(
            &test.0,
            ChildRole::Core,
            generation,
            child("/bin/sleep", &["30"]),
        );
        test.0.fail_session(old_generation);
        let diagnostics = test.0.diagnostics();
        assert_eq!(diagnostics.generation, generation);
        let current = diagnostics
            .children
            .iter()
            .find(|child| child.pid == pid)
            .unwrap();
        assert_eq!(current.state, ownership::ChildState::Running);
        assert_eq!(current.kill_outcome, None);
        assert_eq!(diagnostics.children[0].exit_code, Some(17));
        assert_eq!(diagnostics.status, RuntimeDiagnosticStatus::Starting);
    }
}

#[cfg(all(test, unix))]
mod owned_host_shutdown_tests {
    use super::*;
    struct TestRuntime(CoreRuntimeHandle);
    impl Drop for TestRuntime {
        fn drop(&mut self) {
            self.0.stop();
        }
    }
    fn connection() -> RuntimeConnection {
        RuntimeConnection {
            api_base_url: "http://127.0.0.1:18887".into(),
            api_token: "synthetic-only".into(),
            mcp_endpoint: "http://127.0.0.1:18890/mcp".into(),
        }
    }
    // A restartable stop in the Exit path allows an apply-models worker to reopen the session.
    #[test]
    fn owned_host_shutdown_permanently_blocks_new_sessions() {
        let handle = CoreRuntimeHandle::default();
        assert!(handle.shutdown().shutdown_confirmed);
        assert_eq!(handle.begin_session(), Err("runtime_host_closed".into()));
        assert_eq!(handle.begin_session(), Err("runtime_host_closed".into()));
    }
    // Even a worker with the last generation cannot publish readiness after host exit.
    #[test]
    fn owned_host_shutdown_rejects_late_readiness_without_restoring_connection() {
        let handle = CoreRuntimeHandle::default();
        let generation = handle.begin_session().unwrap();
        handle.shutdown();
        handle.set(CoreStatus::Starting);
        assert_eq!(
            handle.accept_connection(generation, connection(), CoreStatus::Managed),
            Err("runtime_host_closed".into())
        );
        assert!(handle.connection_if_ready().is_err());
    }
    // Execute the same spawn boundary as the pinned sidecar; the RED child is ours and RAII-cleaned.
    #[test]
    fn owned_host_shutdown_spawn_barrier_survives_a_restart_attempt() {
        let test = TestRuntime(CoreRuntimeHandle::default());
        test.0.shutdown();
        let generation = test
            .0
            .begin_session()
            .unwrap_or_else(|_| test.0.diagnostics().generation);
        let result = test.0.spawn_owned(generation, ChildRole::Core, || {
            std::process::Command::new("/bin/sleep")
                .arg("30")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
        });
        assert_eq!(result, Err("runtime_host_closed".into()));
        assert!(test.0.diagnostics().children.is_empty());
    }
}
