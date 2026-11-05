use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager};

use crate::capture::{CaptureState, IntakeShortcutStatus, ShortcutRegistration};
use crate::shortcut_settings::{ShortcutBinding, ShortcutBindings};

const SHORTCUTS_CHANGED: &str = "noltri-shortcuts-changed";

fn config_directory(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(crate::settings::directory)
        .map_err(|_| "shortcut_persistence_failed".into())
}

pub fn register_global_shortcuts(app: AppHandle) {
    #[cfg(target_os = "macos")]
    let status = macos::register(&app, config_directory(&app));
    #[cfg(not(target_os = "macos"))]
    let status = IntakeShortcutStatus::default();
    app.state::<Arc<CaptureState>>()
        .inner()
        .set_shortcut_status(status);
}

/// Carbon operations always execute on the main thread. The async command never
/// blocks that thread while waiting for a queued callback.
#[tauri::command]
pub async fn save_intake_shortcuts(
    app: AppHandle,
    bindings: ShortcutBindings,
) -> Result<IntakeShortcutStatus, String> {
    bindings.validate()?;
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    let scheduled_app = app.clone();
    app.run_on_main_thread(move || {
        let result = save_on_main_thread(&scheduled_app, bindings);
        let _ = sender.try_send(result);
    })
    .map_err(|_| "shortcut_main_thread_unavailable".to_owned())?;
    receiver
        .recv()
        .await
        .ok_or_else(|| "shortcut_main_thread_unavailable".to_owned())?
}

fn save_on_main_thread(
    app: &AppHandle,
    bindings: ShortcutBindings,
) -> Result<IntakeShortcutStatus, String> {
    #[cfg(target_os = "macos")]
    let (result, status) = macos::save(bindings);
    #[cfg(not(target_os = "macos"))]
    let (result, status) = {
        let _ = bindings;
        (
            Err::<(), String>("shortcut_unavailable".into()),
            IntakeShortcutStatus::default(),
        )
    };
    app.state::<Arc<CaptureState>>()
        .inner()
        .set_shortcut_status(status.clone());
    result?;
    let _ = app.emit(SHORTCUTS_CHANGED, &status);
    Ok(status)
}

/// Called from Tauri's main-thread Exit callback; only releases our own refs.
pub fn unregister_global_shortcuts() {
    #[cfg(target_os = "macos")]
    macos::unregister();
}

// The transaction and ownership state are independent of Carbon. Tests substitute
// only acquisition/release, while exercising this exact routing and persistence.
trait HotKeyBackend {
    fn acquire(&mut self, binding: &ShortcutBinding, id: u32) -> Acquisition;
    fn release(&mut self, reference: usize) -> bool;
}
struct Acquisition {
    reference: Option<usize>,
    state: ShortcutRegistration,
}
struct Lease {
    binding: ShortcutBinding,
    id: u32,
    reference: usize,
    usable: bool,
}
struct Registry<B> {
    backend: B,
    bindings: ShortcutBindings,
    leases: Vec<Lease>,
    states: [ShortcutRegistration; 2],
    configuration_error: Option<String>,
    next_id: u32,
}
impl<B: HotKeyBackend> Registry<B> {
    fn new(backend: B, bindings: ShortcutBindings) -> Self {
        Self {
            backend,
            bindings,
            leases: Vec::new(),
            states: [ShortcutRegistration::Unavailable; 2],
            configuration_error: None,
            next_id: 1,
        }
    }
    fn status(&self) -> IntakeShortcutStatus {
        IntakeShortcutStatus {
            screenshot: self.states[0],
            open_intake: self.states[1],
            bindings: self.bindings.clone(),
            configuration_error: self.configuration_error.clone(),
        }
    }
    fn has_binding(&self, binding: &ShortcutBinding) -> bool {
        self.leases
            .iter()
            .any(|lease| lease.usable && &lease.binding == binding)
    }
    fn acquire(&mut self, binding: &ShortcutBinding) -> ShortcutRegistration {
        if self.has_binding(binding) {
            return ShortcutRegistration::Registered;
        }
        let Some(next_id) = self.next_id.checked_add(1) else {
            return ShortcutRegistration::Unavailable;
        };
        let id = self.next_id;
        self.next_id = next_id;
        let result = self.backend.acquire(binding, id);
        let state = if result.reference.is_none() {
            match result.state {
                ShortcutRegistration::Registered => ShortcutRegistration::Unavailable,
                other => other,
            }
        } else {
            result.state
        };
        if let Some(reference) = result.reference {
            // Even an error accompanied by a reference must remain owned until a
            // release succeeds; it cannot become an active route on error.
            self.leases.push(Lease {
                binding: binding.clone(),
                id,
                reference,
                usable: state == ShortcutRegistration::Registered,
            });
        }
        state
    }
    fn initialize(&mut self) {
        let bindings = self.bindings.clone();
        self.states = [
            self.acquire(&bindings.screenshot),
            self.acquire(&bindings.open_intake),
        ];
        self.cleanup_inactive();
    }
    fn release_matching(&mut self, matches: impl Fn(&Lease) -> bool) -> bool {
        let leases = std::mem::take(&mut self.leases);
        let mut complete = true;
        for lease in leases {
            if matches(&lease) {
                if !self.backend.release(lease.reference) {
                    complete = false;
                    self.leases.push(lease);
                }
            } else {
                self.leases.push(lease);
            }
        }
        complete
    }
    fn cleanup_inactive(&mut self) {
        let bindings = self.bindings.clone();
        if !self.release_matching(|lease| {
            !lease.usable
                || (lease.binding != bindings.screenshot && lease.binding != bindings.open_intake)
        }) {
            self.configuration_error = Some("shortcut_cleanup_pending".into());
        }
    }
    fn rollback(&mut self, first_staged_id: u32) {
        if !self.release_matching(|lease| lease.id >= first_staged_id) {
            self.configuration_error = Some("shortcut_cleanup_pending".into());
        }
    }
    fn rebind(
        &mut self,
        bindings: ShortcutBindings,
        persist: impl FnOnce(&ShortcutBindings) -> Result<(), String>,
    ) -> Result<(), String> {
        bindings.validate()?;
        // Some failed OS acquisitions can still return an owned reference. Such
        // a reference cannot route events, but can block a retry until released.
        if !self.release_matching(|lease| !lease.usable) {
            self.configuration_error = Some("shortcut_cleanup_pending".into());
        } else if self.configuration_error.as_deref() == Some("shortcut_cleanup_pending")
            && self.leases.iter().all(|lease| {
                lease.binding == self.bindings.screenshot
                    || lease.binding == self.bindings.open_intake
            })
        {
            self.configuration_error = None;
        }
        let first_staged_id = self.next_id;
        for binding in [&bindings.screenshot, &bindings.open_intake] {
            match self.acquire(binding) {
                ShortcutRegistration::Registered => {}
                failure => {
                    self.rollback(first_staged_id);
                    return Err(if failure == ShortcutRegistration::Conflict {
                        "shortcut_conflict"
                    } else {
                        "shortcut_unavailable"
                    }
                    .into());
                }
            }
        }
        if let Err(error) = persist(&bindings) {
            self.rollback(first_staged_id);
            return Err(error);
        }
        // Persist is the namespace commit. From here onward cleanup errors are
        // reported in committed status, never as a rollback or failed save.
        self.bindings = bindings;
        self.states = [ShortcutRegistration::Registered; 2];
        self.configuration_error = None;
        self.cleanup_inactive();
        Ok(())
    }
    fn action(&self, id: u32) -> Option<&'static str> {
        let lease = self
            .leases
            .iter()
            .find(|lease| lease.id == id && lease.usable)?;
        if lease.binding == self.bindings.screenshot {
            Some("capture")
        } else if lease.binding == self.bindings.open_intake {
            Some("openIntake")
        } else {
            None
        }
    }
    fn unregister_all(&mut self) {
        let complete = self.release_matching(|_| true);
        self.states = [
            if self.has_binding(&self.bindings.screenshot) {
                ShortcutRegistration::Registered
            } else {
                ShortcutRegistration::Unavailable
            },
            if self.has_binding(&self.bindings.open_intake) {
                ShortcutRegistration::Registered
            } else {
                ShortcutRegistration::Unavailable
            },
        ];
        self.configuration_error = if complete {
            None
        } else {
            Some("shortcut_cleanup_pending".into())
        };
    }
}

#[cfg(test)]
mod transaction_tests {
    use super::*;
    use crate::capture::ShortcutRegistration::{Conflict, Registered};
    use crate::shortcut_settings::{self, ShortcutBinding, ShortcutBindings};
    use std::collections::{HashMap, HashSet};
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::sync::atomic::{AtomicU64, Ordering};

    // Only the unavoidable OS registration boundary is replaced. Transaction state,
    // routing, validation, persistence and rollback all use production code.
    #[derive(Default)]
    struct CarbonBoundary {
        held: HashMap<usize, ShortcutBinding>,
        conflicts: HashSet<String>,
        fail_release: HashSet<usize>,
        error_with_reference: HashSet<String>,
    }
    impl HotKeyBackend for CarbonBoundary {
        fn acquire(&mut self, binding: &ShortcutBinding, id: u32) -> Acquisition {
            if self.conflicts.contains(&binding.key)
                || self.held.values().any(|held| held == binding)
            {
                return Acquisition {
                    reference: None,
                    state: Conflict,
                };
            }
            self.held.insert(id as usize, binding.clone());
            Acquisition {
                reference: Some(id as usize),
                state: if self.error_with_reference.contains(&binding.key) {
                    ShortcutRegistration::Unavailable
                } else {
                    Registered
                },
            }
        }
        fn release(&mut self, reference: usize) -> bool {
            if self.fail_release.contains(&reference) {
                return false;
            }
            self.held.remove(&reference).is_some()
        }
    }
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Profile(std::path::PathBuf);
    impl Profile {
        fn new() -> Self {
            let path = std::fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!(
                    "noltri-shortcut-transaction-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
            std::fs::create_dir(&path).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            Self(path)
        }
    }
    impl Drop for Profile {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn registry() -> Registry<CarbonBoundary> {
        let mut registry = Registry::new(CarbonBoundary::default(), ShortcutBindings::default());
        registry.initialize();
        registry
    }
    fn changed() -> ShortcutBindings {
        let mut bindings = ShortcutBindings::default();
        bindings.screenshot.key = "A".into();
        bindings.open_intake.key = "B".into();
        bindings
    }
    fn lease_id(registry: &Registry<CarbonBoundary>, key: &str) -> u32 {
        registry
            .leases
            .iter()
            .find(|lease| lease.binding.key == key && lease.usable)
            .unwrap()
            .id
    }

    // Empty initialization or fixed role IDs would break observable dispatch.
    #[test]
    fn initial_owned_leases_route_only_the_two_configured_actions() {
        let registry = registry();
        assert_eq!(registry.states, [Registered, Registered]);
        assert_eq!(registry.action(lease_id(&registry, "S")), Some("capture"));
        assert_eq!(
            registry.action(lease_id(&registry, "V")),
            Some("openIntake")
        );
        assert_eq!(registry.action(999), None);
    }

    // Acquiring a swapped key twice would conflict with our own exclusive lease.
    #[test]
    fn swapping_actions_reuses_own_leases_and_persists_new_routing() {
        let profile = Profile::new();
        let mut registry = registry();
        let old_s = lease_id(&registry, "S");
        let old_v = lease_id(&registry, "V");
        let mut bindings = ShortcutBindings::default();
        std::mem::swap(&mut bindings.screenshot, &mut bindings.open_intake);
        registry
            .rebind(bindings, |bindings| {
                shortcut_settings::save(&profile.0, bindings)
            })
            .unwrap();
        assert_eq!(registry.action(old_s), Some("openIntake"));
        assert_eq!(registry.action(old_v), Some("capture"));
        assert_eq!(registry.leases.len(), 2);
        assert_eq!(
            shortcut_settings::load(&profile.0).unwrap().screenshot.key,
            "V"
        );
    }

    // Publishing before all acquisitions, or losing old refs on failure, breaks this rollback.
    #[test]
    fn conflict_after_one_acquisition_preserves_old_routing_and_file() {
        let profile = Profile::new();
        shortcut_settings::save(&profile.0, &ShortcutBindings::default()).unwrap();
        let before = std::fs::read(profile.0.join("shortcuts.json")).unwrap();
        let mut registry = registry();
        registry.backend.conflicts.insert("B".into());
        assert_eq!(
            registry
                .rebind(changed(), |bindings| shortcut_settings::save(
                    &profile.0, bindings
                ))
                .unwrap_err(),
            "shortcut_conflict"
        );
        assert_eq!(registry.bindings.screenshot.key, "S");
        assert_eq!(registry.action(lease_id(&registry, "S")), Some("capture"));
        assert_eq!(registry.leases.len(), 2);
        assert_eq!(
            std::fs::read(profile.0.join("shortcuts.json")).unwrap(),
            before
        );
    }

    // A real unsafe destination causes precommit failure after staging both replacements.
    #[test]
    fn persistence_failure_releases_staged_leases_and_keeps_old_actions() {
        let profile = Profile::new();
        let target = profile.0.join("unrelated");
        std::fs::write(&target, b"unchanged").unwrap();
        symlink(&target, profile.0.join("shortcuts.json")).unwrap();
        let mut registry = registry();
        assert_eq!(
            registry
                .rebind(changed(), |bindings| shortcut_settings::save(
                    &profile.0, bindings
                ))
                .unwrap_err(),
            "shortcut_persistence_failed"
        );
        assert_eq!(registry.bindings.screenshot.key, "S");
        assert_eq!(registry.leases.len(), 2);
        assert_eq!(
            registry.action(lease_id(&registry, "V")),
            Some("openIntake")
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"unchanged");
    }

    // Treating unchanged config as a no-op would never repair a missing lease.
    #[test]
    fn same_bindings_retry_missing_registration_without_duplicating_owned_keys() {
        let profile = Profile::new();
        let mut backend = CarbonBoundary::default();
        backend.conflicts.insert("V".into());
        let mut registry = Registry::new(backend, ShortcutBindings::default());
        registry.initialize();
        assert_eq!(registry.states, [Registered, Conflict]);
        let old_s = lease_id(&registry, "S");
        registry.backend.conflicts.clear();
        registry
            .rebind(ShortcutBindings::default(), |bindings| {
                shortcut_settings::save(&profile.0, bindings)
            })
            .unwrap();
        assert_eq!(registry.states, [Registered, Registered]);
        assert_eq!(lease_id(&registry, "S"), old_s);
        registry
            .rebind(ShortcutBindings::default(), |bindings| {
                shortcut_settings::save(&profile.0, bindings)
            })
            .unwrap();
        assert_eq!(registry.leases.len(), 2);
    }

    // A failed release is not proof that a lease stopped existing.
    #[test]
    fn committed_cleanup_failure_keeps_refs_and_routes_only_committed_bindings() {
        let profile = Profile::new();
        let mut registry = registry();
        let old_s = lease_id(&registry, "S");
        registry.backend.fail_release.insert(old_s as usize);
        registry
            .rebind(changed(), |bindings| {
                shortcut_settings::save(&profile.0, bindings)
            })
            .unwrap();
        assert_eq!(
            shortcut_settings::load(&profile.0).unwrap().screenshot.key,
            "A"
        );
        assert_eq!(registry.bindings.screenshot.key, "A");
        assert_eq!(
            registry.configuration_error.as_deref(),
            Some("shortcut_cleanup_pending")
        );
        assert!(registry.leases.iter().any(|lease| lease.id == old_s));
        assert_eq!(registry.action(old_s), None);
        assert_eq!(registry.action(lease_id(&registry, "A")), Some("capture"));
        registry.backend.fail_release.clear();
        registry
            .rebind(changed(), |bindings| {
                shortcut_settings::save(&profile.0, bindings)
            })
            .unwrap();
        assert!(registry.configuration_error.is_none());
        assert_eq!(registry.leases.len(), 2);
        registry.unregister_all();
        assert!(registry.leases.is_empty());
        assert_eq!(registry.action(old_s), None);
    }

    // If an unsuccessful acquisition returned a ref, a later retry must first
    // release that unusable own ref rather than conflict with it indefinitely.
    #[test]
    fn retry_releases_unusable_owned_reference_before_reacquiring_missing_key() {
        let profile = Profile::new();
        let mut backend = CarbonBoundary::default();
        backend.error_with_reference.insert("S".into());
        backend.fail_release.insert(1);
        let mut registry = Registry::new(backend, ShortcutBindings::default());
        registry.initialize();
        assert_eq!(registry.action(1), None);
        assert_eq!(
            registry.configuration_error.as_deref(),
            Some("shortcut_cleanup_pending")
        );
        registry.backend.error_with_reference.clear();
        registry.backend.fail_release.clear();
        registry
            .rebind(ShortcutBindings::default(), |bindings| {
                shortcut_settings::save(&profile.0, bindings)
            })
            .unwrap();
        assert_eq!(registry.states, [Registered, Registered]);
        assert_eq!(registry.leases.len(), 2);
        assert!(registry.configuration_error.is_none());
        assert_eq!(registry.action(lease_id(&registry, "S")), Some("capture"));
    }

    #[test]
    fn rollback_cleanup_failure_retains_unrouted_ref_until_exit_retry() {
        let profile = Profile::new();
        let mut registry = registry();
        registry.backend.conflicts.insert("B".into());
        registry.backend.fail_release.insert(3);
        assert!(registry
            .rebind(changed(), |bindings| shortcut_settings::save(
                &profile.0, bindings
            ))
            .is_err());
        assert_eq!(registry.bindings.screenshot.key, "S");
        assert_eq!(
            registry.configuration_error.as_deref(),
            Some("shortcut_cleanup_pending")
        );
        assert!(registry.leases.iter().any(|lease| lease.id == 3));
        assert_eq!(registry.action(3), None);
        registry.unregister_all();
        assert_eq!(registry.leases.len(), 1);
        registry.backend.fail_release.clear();
        registry.unregister_all();
        assert!(registry.leases.is_empty());
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use crate::capture::{
        emit_global_activation, new_request_id, CaptureTrace, CaptureTraceErrorCode,
        CaptureTraceStage,
    };
    use std::ffi::c_void;
    use std::path::PathBuf;
    use std::sync::{Mutex, OnceLock};

    type OsStatus = i32;
    type EventRef = *mut c_void;
    #[repr(C)]
    struct EventTypeSpec {
        event_class: u32,
        event_kind: u32,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct EventHotKeyId {
        signature: u32,
        id: u32,
    }
    type EventHandlerProc = unsafe extern "C" fn(*mut c_void, EventRef, *mut c_void) -> OsStatus;
    const NO_ERR: OsStatus = 0;
    const EVENT_HOT_KEY_EXISTS_ERR: OsStatus = -9_878;
    const EVENT_CLASS_KEYBOARD: u32 = u32::from_be_bytes(*b"keyb");
    const EVENT_PARAM_DIRECT_OBJECT: u32 = u32::from_be_bytes(*b"----");
    const TYPE_EVENT_HOT_KEY_ID: u32 = u32::from_be_bytes(*b"hkid");
    const APP_HOT_KEY_SIGNATURE: u32 = u32::from_be_bytes(*b"NOLT");
    const EVENT_HOT_KEY_PRESSED: u32 = 5;
    const HOT_KEY_EXCLUSIVE: u32 = 1;

    struct Carbon {
        target: usize,
    }
    impl HotKeyBackend for Carbon {
        fn acquire(&mut self, binding: &ShortcutBinding, id: u32) -> Acquisition {
            let Some(key_code) = key_code(&binding.key) else {
                return Acquisition {
                    reference: None,
                    state: ShortcutRegistration::Unavailable,
                };
            };
            if self.target == 0 {
                return Acquisition {
                    reference: None,
                    state: ShortcutRegistration::Unavailable,
                };
            }
            let mut reference: *mut c_void = std::ptr::null_mut();
            let status = unsafe {
                RegisterEventHotKey(
                    key_code,
                    modifiers(binding),
                    EventHotKeyId {
                        signature: APP_HOT_KEY_SIGNATURE,
                        id,
                    },
                    self.target as *mut c_void,
                    HOT_KEY_EXCLUSIVE,
                    &mut reference,
                )
            };
            Acquisition {
                reference: (!reference.is_null()).then_some(reference as usize),
                state: registration_status(status, !reference.is_null()),
            }
        }
        fn release(&mut self, reference: usize) -> bool {
            unsafe { UnregisterEventHotKey(reference as *mut c_void) == NO_ERR }
        }
    }
    struct Host {
        app: Option<AppHandle>,
        directory: Option<PathBuf>,
        registry: Registry<Carbon>,
        handler: Option<usize>,
    }
    static HOST: OnceLock<Mutex<Option<Host>>> = OnceLock::new();
    fn slot() -> &'static Mutex<Option<Host>> {
        HOST.get_or_init(|| Mutex::new(None))
    }
    impl Host {
        fn ensure_handler(&mut self) -> bool {
            if self.handler.is_some() {
                return true;
            }
            let target = unsafe { GetApplicationEventTarget() };
            if target.is_null() {
                return false;
            }
            let event_type = EventTypeSpec {
                event_class: EVENT_CLASS_KEYBOARD,
                event_kind: EVENT_HOT_KEY_PRESSED,
            };
            let mut handler = std::ptr::null_mut();
            let status = unsafe {
                InstallEventHandler(
                    target,
                    Some(on_hot_key_pressed),
                    1,
                    &event_type,
                    std::ptr::null_mut(),
                    &mut handler,
                )
            };
            if !handler.is_null() {
                self.handler = Some(handler as usize);
            }
            if status != NO_ERR || handler.is_null() {
                return false;
            }
            self.registry.backend.target = target as usize;
            true
        }
    }
    pub(super) fn register(
        app: &AppHandle,
        directory: Result<PathBuf, String>,
    ) -> IntakeShortcutStatus {
        let mut installed = slot()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(host) = installed.as_mut() {
            host.app = Some(app.clone());
            return host.registry.status();
        }
        let loaded = directory
            .as_ref()
            .map_err(Clone::clone)
            .and_then(|path| crate::shortcut_settings::load(path));
        let mut host = Host {
            app: Some(app.clone()),
            directory: directory.ok(),
            registry: Registry::new(
                Carbon { target: 0 },
                loaded.as_ref().cloned().unwrap_or_default(),
            ),
            handler: None,
        };
        match loaded {
            Ok(_) => {
                if host.ensure_handler() {
                    host.registry.initialize();
                }
            }
            Err(error) => host.registry.configuration_error = Some(error),
        }
        let status = host.registry.status();
        *installed = Some(host);
        status
    }
    pub(super) fn save(bindings: ShortcutBindings) -> (Result<(), String>, IntakeShortcutStatus) {
        let mut installed = slot()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(host) = installed.as_mut() else {
            return (
                Err("shortcut_state_unavailable".into()),
                IntakeShortcutStatus::default(),
            );
        };
        let Some(directory) = host.directory.clone() else {
            return (
                Err("shortcut_persistence_failed".into()),
                host.registry.status(),
            );
        };
        if !host.ensure_handler() {
            return (Err("shortcut_unavailable".into()), host.registry.status());
        }
        let result = host.registry.rebind(bindings, |bindings| {
            crate::shortcut_settings::save(&directory, bindings)
        });
        (result, host.registry.status())
    }
    pub(super) fn unregister() {
        let mut installed = slot()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(host) = installed.as_mut() else {
            return;
        };
        host.app = None;
        host.registry.unregister_all();
        if host.registry.leases.is_empty() {
            if let Some(handler) = host.handler {
                if unsafe { RemoveEventHandler(handler as *mut c_void) } == NO_ERR {
                    host.handler = None;
                    host.registry.backend.target = 0;
                } else {
                    host.registry.configuration_error = Some("shortcut_cleanup_pending".into());
                }
            }
        }
    }
    unsafe extern "C" fn on_hot_key_pressed(
        _call: *mut c_void,
        event: EventRef,
        _data: *mut c_void,
    ) -> OsStatus {
        let trace = CaptureTrace::new(new_request_id());
        let mut hot_key_id = EventHotKeyId {
            signature: 0,
            id: 0,
        };
        let status = unsafe {
            GetEventParameter(
                event,
                EVENT_PARAM_DIRECT_OBJECT,
                TYPE_EVENT_HOT_KEY_ID,
                std::ptr::null_mut(),
                std::mem::size_of::<EventHotKeyId>() as u32,
                std::ptr::null_mut(),
                (&mut hot_key_id as *mut EventHotKeyId).cast(),
            )
        };
        if status != NO_ERR || hot_key_id.signature != APP_HOT_KEY_SIGNATURE {
            trace.log(
                CaptureTraceStage::ShortcutReceived,
                Some(CaptureTraceErrorCode::Unexpected),
            );
            return NO_ERR;
        }
        let activation = slot().lock().ok().and_then(|installed| {
            let host = installed.as_ref()?;
            Some((host.app.clone()?, host.registry.action(hot_key_id.id)?))
        });
        if let Some((app, action)) = activation {
            trace.log(CaptureTraceStage::ShortcutReceived, None);
            let state = app.state::<Arc<CaptureState>>();
            emit_global_activation(&app, state.inner().as_ref(), action, trace);
        }
        NO_ERR
    }
    fn registration_status(status: OsStatus, has_ref: bool) -> ShortcutRegistration {
        if status == NO_ERR && has_ref {
            ShortcutRegistration::Registered
        } else if status == EVENT_HOT_KEY_EXISTS_ERR {
            ShortcutRegistration::Conflict
        } else {
            ShortcutRegistration::Unavailable
        }
    }
    fn key_code(key: &str) -> Option<u32> {
        Some(match key {
            "A" => 0x00,
            "B" => 0x0b,
            "C" => 0x08,
            "D" => 0x02,
            "E" => 0x0e,
            "F" => 0x03,
            "G" => 0x05,
            "H" => 0x04,
            "I" => 0x22,
            "J" => 0x26,
            "K" => 0x28,
            "L" => 0x25,
            "M" => 0x2e,
            "N" => 0x2d,
            "O" => 0x1f,
            "P" => 0x23,
            "Q" => 0x0c,
            "R" => 0x0f,
            "S" => 0x01,
            "T" => 0x11,
            "U" => 0x20,
            "V" => 0x09,
            "W" => 0x0d,
            "X" => 0x07,
            "Y" => 0x10,
            "Z" => 0x06,
            _ => return None,
        })
    }
    fn modifiers(binding: &ShortcutBinding) -> u32 {
        (if binding.meta { 1 << 8 } else { 0 })
            | (if binding.shift { 1 << 9 } else { 0 })
            | (if binding.alt { 1 << 11 } else { 0 })
            | (if binding.control { 1 << 12 } else { 0 })
    }
    #[link(name = "Carbon", kind = "framework")]
    unsafe extern "C" {
        fn GetApplicationEventTarget() -> *mut c_void;
        fn InstallEventHandler(
            target: *mut c_void,
            handler: Option<EventHandlerProc>,
            count: u32,
            types: *const EventTypeSpec,
            data: *mut c_void,
            out: *mut *mut c_void,
        ) -> OsStatus;
        fn RemoveEventHandler(handler: *mut c_void) -> OsStatus;
        fn RegisterEventHotKey(
            key: u32,
            modifiers: u32,
            id: EventHotKeyId,
            target: *mut c_void,
            options: u32,
            out: *mut *mut c_void,
        ) -> OsStatus;
        fn UnregisterEventHotKey(reference: *mut c_void) -> OsStatus;
        fn GetEventParameter(
            event: EventRef,
            name: u32,
            desired: u32,
            actual: *mut u32,
            size: u32,
            actual_size: *mut u32,
            data: *mut c_void,
        ) -> OsStatus;
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        // Missing or wrong virtual codes would register a different physical key.
        #[test]
        fn every_supported_letter_maps_to_its_carbon_virtual_key() {
            for (letter, code) in [
                ("A", 0x00),
                ("B", 0x0b),
                ("C", 0x08),
                ("D", 0x02),
                ("E", 0x0e),
                ("F", 0x03),
                ("G", 0x05),
                ("H", 0x04),
                ("I", 0x22),
                ("J", 0x26),
                ("K", 0x28),
                ("L", 0x25),
                ("M", 0x2e),
                ("N", 0x2d),
                ("O", 0x1f),
                ("P", 0x23),
                ("Q", 0x0c),
                ("R", 0x0f),
                ("S", 0x01),
                ("T", 0x11),
                ("U", 0x20),
                ("V", 0x09),
                ("W", 0x0d),
                ("X", 0x07),
                ("Y", 0x10),
                ("Z", 0x06),
            ] {
                assert_eq!(key_code(letter), Some(code), "{letter}");
            }
            assert_eq!(key_code("1"), None);
            assert_eq!(key_code("a"), None);
        }
        // Fixed legacy modifiers would silently ignore the chosen modifier set.
        #[test]
        fn carbon_modifier_mask_preserves_each_selected_modifier() {
            let mut binding = ShortcutBindings::default().screenshot;
            assert_eq!(modifiers(&binding), 0x1900);
            binding.control = false;
            binding.alt = false;
            binding.shift = true;
            assert_eq!(modifiers(&binding), 0x0300);
            binding.meta = false;
            binding.control = true;
            assert_eq!(modifiers(&binding), 0x1200);
        }
        #[test]
        fn carbon_conflicts_are_reported_separately_from_unavailable_errors() {
            assert_eq!(
                registration_status(NO_ERR, true),
                ShortcutRegistration::Registered
            );
            assert_eq!(
                registration_status(EVENT_HOT_KEY_EXISTS_ERR, false),
                ShortcutRegistration::Conflict
            );
            assert_eq!(
                registration_status(-1, false),
                ShortcutRegistration::Unavailable
            );
            assert_eq!(
                registration_status(NO_ERR, false),
                ShortcutRegistration::Unavailable
            );
        }
    }
}
