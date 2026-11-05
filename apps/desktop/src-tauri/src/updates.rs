//! Explicit, main-window-only official updater. No startup network requests.
use serde::Serialize;
use std::time::Duration;
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Copy, PartialEq, Debug)]
enum Phase {
    Idle,
    Available,
    Downloaded,
    Installed,
    Uncertain,
}
#[derive(Clone, Copy)]
enum Action {
    Check,
    Download,
    Install,
    Restart,
}
fn authorize(label: &str, phase: Phase, action: Action) -> Result<(), &'static str> {
    if label != "main" {
        return Err("main_window_required");
    }
    let allowed = match action {
        Action::Check => matches!(phase, Phase::Idle | Phase::Available | Phase::Downloaded),
        Action::Download => phase == Phase::Available,
        Action::Install => phase == Phase::Downloaded,
        Action::Restart => phase == Phase::Installed,
    };
    if allowed {
        Ok(())
    } else {
        Err("invalid_update_state")
    }
}

// Expose only stable codes: updater errors may contain signed URLs, signatures or local paths.
fn download_error_code(error: &tauri_plugin_updater::Error) -> &'static str {
    use tauri_plugin_updater::Error;
    match error {
        Error::Minisign(_) => "update_signature_invalid",
        Error::SignedVersionMismatch { .. } => "update_signed_version_mismatch",
        Error::MissingSignedVersion => "update_signed_version_missing",
        Error::Base64(_) | Error::SignatureUtf8(_) => "update_signature_metadata_invalid",
        // In the official download path Network is emitted for a non-success HTTP response.
        Error::Network(_) => "update_download_http_failed",
        Error::Reqwest(error) if error.is_timeout() => "update_download_timeout",
        Error::Reqwest(error) if error.status().is_some() => "update_download_http_failed",
        Error::Reqwest(error) if error.is_body() || error.is_decode() => {
            "update_download_stream_failed"
        }
        Error::Reqwest(error) if error.is_connect() || error.is_request() => {
            "update_download_network_failed"
        }
        _ => "update_download_failed_unknown",
    }
}

// These categories describe the returned installer error, never an inferred system permission decision.
// No Display/raw path or URL is returned, and the caller keeps the existing Uncertain state.
fn install_error_code(error: &tauri_plugin_updater::Error) -> &'static str {
    use std::io::ErrorKind;
    use tauri_plugin_updater::Error;
    match error {
        Error::TempDirNotOnSameMountPoint => "update_install_wrong_volume",
        Error::PreviousAppNotRestored(_) => "update_install_backup_preserved",
        Error::Io(error) => match error.kind() {
            ErrorKind::PermissionDenied => "update_install_permission_denied",
            ErrorKind::ReadOnlyFilesystem => "update_install_read_only",
            ErrorKind::StorageFull => "update_install_disk_full",
            ErrorKind::NotFound => "update_install_missing_file",
            ErrorKind::CrossesDevices => "update_install_cross_device",
            ErrorKind::InvalidData => "update_install_invalid_data",
            _ => "update_install_failed_manual_recovery_required",
        },
        _ => "update_install_failed_manual_recovery_required",
    }
}

struct Session {
    phase: Phase,
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
}
impl Default for Session {
    fn default() -> Self {
        Self {
            phase: Phase::Idle,
            update: None,
            bytes: None,
        }
    }
}
#[derive(Default)]
pub struct UpdateState(tauri::async_runtime::Mutex<Session>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    status: &'static str,
    version: Option<String>,
    notes: Option<String>,
}
fn snapshot(s: &Session) -> UpdateStatus {
    UpdateStatus {
        status: match s.phase {
            Phase::Idle => "up_to_date",
            Phase::Available => "available",
            Phase::Downloaded => "downloaded",
            Phase::Installed => "installed",
            Phase::Uncertain => "uncertain",
        },
        version: s.update.as_ref().map(|u| u.version.clone()),
        notes: s.update.as_ref().and_then(|u| u.body.clone()),
    }
}
// try_lock rejects overlapping operations; this is an async mutex, never a sync guard across await.
#[tauri::command]
pub async fn check_native_update(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, UpdateState>,
) -> Result<UpdateStatus, String> {
    authorize(window.label(), Phase::Idle, Action::Check)?;
    let mut s = state.0.try_lock().map_err(|_| "update_busy")?;
    authorize(window.label(), s.phase, Action::Check)?;
    *s = Session::default();
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(120))
        .configure_client(|client| client.https_only(true).timeout(Duration::from_secs(120)))
        .restart_after_install(false)
        .build()
        .map_err(|_| "updater_configuration_failed")?;
    let update = updater.check().await.map_err(|_| "update_check_failed")?;
    // Enforce HTTPS for the artifact too, including debug builds. No URL comes from IPC.
    if update
        .as_ref()
        .is_some_and(|u| u.download_url.scheme() != "https")
    {
        return Err("insecure_update_artifact".into());
    }
    s.phase = if update.is_some() {
        Phase::Available
    } else {
        Phase::Idle
    };
    s.update = update;
    Ok(snapshot(&s))
}
#[tauri::command]
pub async fn download_native_update(
    window: WebviewWindow,
    state: State<'_, UpdateState>,
) -> Result<UpdateStatus, String> {
    authorize(window.label(), Phase::Available, Action::Download)?;
    let mut s = state.0.try_lock().map_err(|_| "update_busy")?;
    authorize(window.label(), s.phase, Action::Download)?;
    let update = s.update.as_ref().ok_or("missing_update")?;
    // Official download returns only after minisign and required signed-version verification.
    // Its finish callback runs BEFORE verification, so it must never mark a download trusted.
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|error| download_error_code(&error))?;
    s.bytes = Some(bytes);
    s.phase = Phase::Downloaded;
    Ok(snapshot(&s))
}
#[tauri::command]
pub async fn install_native_update(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, UpdateState>,
    confirmed: bool,
) -> Result<UpdateStatus, String> {
    authorize(window.label(), Phase::Downloaded, Action::Install)?;
    if !confirmed {
        return Err("explicit_confirmation_required".into());
    }
    if app.get_webview_window("processing-console").is_some() {
        return Err("save_and_close_processing_console_first".into());
    }
    let mut s = state.0.try_lock().map_err(|_| "update_busy")?;
    authorize(window.label(), s.phase, Action::Install)?;
    let update = s.update.as_ref().ok_or("missing_update")?.clone();
    let bytes = s.bytes.take().ok_or("missing_verified_download")?;
    // Installation may partially change files on error. Never retry or restart from uncertain state.
    s.phase = Phase::Uncertain;
    tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|_| "update_install_outcome_uncertain")?
        .map_err(|error| install_error_code(&error))?;
    s.phase = Phase::Installed;
    Ok(snapshot(&s))
}
#[tauri::command]
pub async fn restart_after_native_update(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, UpdateState>,
    confirmed: bool,
) -> Result<(), String> {
    authorize(window.label(), Phase::Installed, Action::Restart)?;
    if !confirmed {
        return Err("explicit_confirmation_required".into());
    }
    if app.get_webview_window("processing-console").is_some() {
        return Err("save_and_close_processing_console_first".into());
    }
    let s = state.0.try_lock().map_err(|_| "update_busy")?;
    authorize(window.label(), s.phase, Action::Restart)?;
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn secondary_windows_are_denied() {
        for label in ["intake", "processing-console", ""] {
            for action in [
                Action::Check,
                Action::Download,
                Action::Install,
                Action::Restart,
            ] {
                assert!(authorize(label, Phase::Idle, action).is_err());
            }
        }
    }
    #[test]
    fn requires_ordered_explicit_actions() {
        assert!(authorize("main", Phase::Idle, Action::Install).is_err());
        assert!(authorize("main", Phase::Available, Action::Restart).is_err());
        assert!(authorize("main", Phase::Downloaded, Action::Download).is_err());
        assert!(authorize("main", Phase::Uncertain, Action::Check).is_err());
        assert!(authorize("main", Phase::Available, Action::Download).is_ok());
        assert!(authorize("main", Phase::Downloaded, Action::Install).is_ok());
        assert!(authorize("main", Phase::Installed, Action::Restart).is_ok());
    }
    #[test]
    fn production_config_enforces_authenticity() {
        let c: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let u = &c["plugins"]["updater"];
        assert_eq!(u["requireSignedVersion"], true);
        assert_eq!(u["allowDowngrades"], false);
        for key in [
            "dangerousInsecureTransportProtocol",
            "dangerousAcceptInvalidCerts",
            "dangerousAcceptInvalidHostnames",
        ] {
            assert_eq!(u[key], false);
        }
        assert_eq!(
            u["endpoints"],
            serde_json::json!([
                "https://github.com/wyzh0117/noltri/releases/latest/download/latest.json"
            ])
        );
        let config: tauri_plugin_updater::Config = serde_json::from_value(u.clone()).unwrap();
        assert!(config.require_signed_version);
    }
    #[test]
    fn concurrent_operations_are_rejected() {
        let s = UpdateState::default();
        let guard = s.0.try_lock().unwrap();
        assert!(s.0.try_lock().is_err());
        drop(guard);
        assert!(s.0.try_lock().is_ok());
    }
    #[test]
    fn download_integrity_errors_have_fixed_codes_not_transport_messages() {
        use tauri_plugin_updater::Error as E;
        for (error, expected) in [
            (
                E::Minisign(minisign_verify::Error::InvalidSignature),
                "update_signature_invalid",
            ),
            (
                E::SignedVersionMismatch {
                    signed: "DUMMY_PRIVATE_SIGNED".into(),
                    announced: "https://dummy.invalid/?token=DUMMY_TOKEN".into(),
                },
                "update_signed_version_mismatch",
            ),
            (E::MissingSignedVersion, "update_signed_version_missing"),
            (
                E::SignatureUtf8("DUMMY_PRIVATE_SIGNATURE".into()),
                "update_signature_metadata_invalid",
            ),
        ] {
            assert_eq!(download_error_code(&error), expected);
        }
    }

    #[test]
    fn http_and_unknown_download_errors_never_expose_inner_data() {
        use tauri_plugin_updater::Error as E;
        let sensitive = "https://dummy.invalid/file?token=DUMMY_TOKEN /DUMMY_PRIVATE_PATH";
        assert_eq!(
            download_error_code(&E::Network(sensitive.into())),
            "update_download_http_failed"
        );
        for error in [
            E::Io(std::io::Error::other(sensitive)),
            E::EmptyEndpoints,
            E::PreviousAppNotRestored(sensitive.into()),
        ] {
            assert_eq!(
                download_error_code(&error),
                "update_download_failed_unknown"
            );
        }
    }

    fn response_error(response: &'static [u8], consume_body: bool) -> reqwest::Error {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 1024];
            stream.read(&mut request).unwrap();
            stream.write_all(response).unwrap();
        });
        let error = tauri::async_runtime::block_on(async {
            let response = reqwest::Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .get(format!("http://{address}/synthetic?token=DUMMY_TOKEN"))
                .send()
                .await
                .unwrap();
            if consume_body {
                response.bytes().await.unwrap_err()
            } else {
                response.error_for_status().unwrap_err()
            }
        });
        worker.join().unwrap();
        error
    }

    #[test]
    fn distinguishes_real_http_and_interrupted_stream_errors() {
        let http = response_error(
            b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            false,
        );
        assert_eq!(
            download_error_code(&http.into()),
            "update_download_http_failed"
        );
        let stream = response_error(
            b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nabc",
            true,
        );
        assert_eq!(
            download_error_code(&stream.into()),
            "update_download_stream_failed"
        );
    }

    #[test]
    fn timeout_during_body_is_timeout_and_connection_failure_is_network() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            sync::mpsc,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let (release, hold) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 1024];
            stream.read(&mut request).unwrap();
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\n")
                .unwrap();
            let _ = hold.recv_timeout(Duration::from_secs(2));
        });
        let timeout = tauri::async_runtime::block_on(async {
            reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_millis(100))
                .build()
                .unwrap()
                .get(format!("http://{address}/synthetic?token=DUMMY_TOKEN"))
                .send()
                .await
                .unwrap()
                .bytes()
                .await
                .unwrap_err()
        });
        let _ = release.send(());
        worker.join().unwrap();
        assert_eq!(
            download_error_code(&timeout.into()),
            "update_download_timeout"
        );
        // The owned listener is now gone: no public service or proxy is used.
        let network = tauri::async_runtime::block_on(async {
            reqwest::Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap()
                .get(format!("http://{address}/synthetic?token=DUMMY_TOKEN"))
                .send()
                .await
                .unwrap_err()
        });
        assert_eq!(
            download_error_code(&network.into()),
            "update_download_network_failed"
        );
    }

    #[test]
    fn invalid_request_configuration_is_unknown_not_automatically_network() {
        let error = tauri::async_runtime::block_on(async {
            reqwest::Client::new()
                .get("not a valid URL DUMMY_PRIVATE_PATH")
                .send()
                .await
                .unwrap_err()
        });
        assert_eq!(
            download_error_code(&error.into()),
            "update_download_failed_unknown"
        );
    }
    #[test]
    fn installation_io_codes_do_not_expose_paths_or_claim_system_authorization() {
        use std::io::{Error, ErrorKind};
        for (kind, expected) in [
            (
                ErrorKind::PermissionDenied,
                "update_install_permission_denied",
            ),
            (ErrorKind::ReadOnlyFilesystem, "update_install_read_only"),
            (ErrorKind::StorageFull, "update_install_disk_full"),
            (ErrorKind::NotFound, "update_install_missing_file"),
            (ErrorKind::CrossesDevices, "update_install_cross_device"),
            (ErrorKind::InvalidData, "update_install_invalid_data"),
        ] {
            let error = tauri_plugin_updater::Error::Io(Error::new(
                kind,
                "https://dummy.invalid/?token=DUMMY_TOKEN /DUMMY_PRIVATE_PATH",
            ));
            assert_eq!(install_error_code(&error), expected);
        }
    }
    #[test]
    fn installation_known_outcomes_and_unknown_errors_remain_whitelisted() {
        use tauri_plugin_updater::Error as E;
        assert_eq!(
            install_error_code(&E::TempDirNotOnSameMountPoint),
            "update_install_wrong_volume"
        );
        assert_eq!(
            install_error_code(&E::PreviousAppNotRestored("/DUMMY_PRIVATE_BACKUP".into())),
            "update_install_backup_preserved"
        );
        assert_eq!(
            install_error_code(&E::Io(std::io::Error::other(
                "token=DUMMY_TOKEN /DUMMY_PRIVATE_PATH"
            ))),
            "update_install_failed_manual_recovery_required"
        );
        assert_eq!(
            install_error_code(&E::EmptyEndpoints),
            "update_install_failed_manual_recovery_required"
        );
    }
}
