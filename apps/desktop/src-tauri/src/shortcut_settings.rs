//! Shortcut-only settings. This module never opens model settings or access credentials.
use std::ffi::CString;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(deny_unknown_fields)]
pub struct ShortcutBinding {
    pub key: String,
    pub control: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShortcutBindings {
    pub screenshot: ShortcutBinding,
    pub open_intake: ShortcutBinding,
}

impl Default for ShortcutBindings {
    fn default() -> Self {
        let binding = |key: &str| ShortcutBinding {
            key: key.into(),
            control: true,
            alt: true,
            shift: false,
            meta: true,
        };
        Self {
            screenshot: binding("S"),
            open_intake: binding("V"),
        }
    }
}

impl ShortcutBindings {
    pub fn validate(&self) -> Result<(), String> {
        for binding in [&self.screenshot, &self.open_intake] {
            if binding.key.len() != 1
                || !binding.key.as_bytes()[0].is_ascii_uppercase()
                || [binding.control, binding.alt, binding.shift, binding.meta]
                    .into_iter()
                    .filter(|enabled| *enabled)
                    .count()
                    < 2
            {
                return Err("shortcut_invalid_binding".into());
            }
        }
        if self.screenshot == self.open_intake {
            return Err("shortcut_duplicate_bindings".into());
        }
        Ok(())
    }
}

const LIMIT: u64 = 4096;
const FILE_NAME: &str = "shortcuts.json";
// Darwin flags, matching the existing secure device_access directory implementation.
const NOFOLLOW: i32 = 0x100;
const CLOEXEC: i32 = 0x1000000;
const NONBLOCK: i32 = 4;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
unsafe extern "C" {
    fn openat(fd: i32, path: *const std::ffi::c_char, flags: i32, ...) -> i32;
    fn unlinkat(fd: i32, path: *const std::ffi::c_char, flags: i32) -> i32;
    fn renameat(
        from_fd: i32,
        from: *const std::ffi::c_char,
        to_fd: i32,
        to: *const std::ffi::c_char,
    ) -> i32;
    fn geteuid() -> u32;
}

fn persistence_error() -> String {
    "shortcut_persistence_failed".into()
}
fn filename(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| persistence_error())
}

fn checked_file(directory: &File) -> Result<Option<File>, String> {
    let name = filename(FILE_NAME)?;
    let fd = unsafe {
        openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            NOFOLLOW | CLOEXEC | NONBLOCK,
        )
    };
    if fd < 0 {
        return if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(persistence_error())
        };
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let meta = file.metadata().map_err(|_| persistence_error())?;
    if !meta.is_file()
        || meta.uid() != unsafe { geteuid() }
        || meta.nlink() != 1
        || meta.mode() & 0o7777 != 0o600
        || meta.len() > LIMIT
    {
        return Err(persistence_error());
    }
    Ok(Some(file))
}

pub fn load(directory: &Path) -> Result<ShortcutBindings, String> {
    let Some(directory) =
        crate::device_access::open_directory(directory, false).map_err(|_| persistence_error())?
    else {
        return Ok(ShortcutBindings::default());
    };
    let Some(mut file) = checked_file(&directory)? else {
        return Ok(ShortcutBindings::default());
    };
    let before = file.metadata().map_err(|_| persistence_error())?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| persistence_error())?;
    let after = file.metadata().map_err(|_| persistence_error())?;
    if bytes.len() as u64 > LIMIT
        || before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
        || after.nlink() != 1
        || after.mode() & 0o7777 != 0o600
    {
        return Err(persistence_error());
    }
    let bindings: ShortcutBindings =
        serde_json::from_slice(&bytes).map_err(|_| "shortcut_configuration_invalid".to_owned())?;
    bindings
        .validate()
        .map_err(|_| "shortcut_configuration_invalid".to_owned())?;
    Ok(bindings)
}

pub fn save(directory: &Path, bindings: &ShortcutBindings) -> Result<(), String> {
    bindings.validate()?;
    let directory = crate::device_access::open_directory(directory, true)
        .map_err(|_| persistence_error())?
        .ok_or_else(persistence_error)?;
    // Validate existing namespace entries without following links, and never open
    // another settings document. Explicit saves may repair malformed private JSON.
    checked_file(&directory)?;
    let bytes = serde_json::to_vec(bindings).map_err(|_| persistence_error())?;
    if bytes.len() as u64 > LIMIT {
        return Err(persistence_error());
    }
    let temporary = filename(&format!(
        ".shortcuts-pending-{}-{}",
        std::process::id(),
        TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ))?;
    let fd = unsafe {
        openat(
            directory.as_raw_fd(),
            temporary.as_ptr(),
            1 | 0x200 | 0x800 | NOFOLLOW | CLOEXEC,
            0o600u32,
        )
    };
    if fd < 0 {
        return Err(persistence_error());
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let result = (|| {
        // Creation mode is filtered by this process's umask. Fail before commit
        // if the resulting file cannot satisfy the exact private-mode contract.
        let meta = file.metadata().map_err(|_| persistence_error())?;
        if !meta.is_file()
            || meta.uid() != unsafe { geteuid() }
            || meta.nlink() != 1
            || meta.mode() & 0o7777 != 0o600
        {
            return Err(persistence_error());
        }
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| persistence_error())?;
        checked_file(&directory)?;
        let target = filename(FILE_NAME)?;
        if unsafe {
            renameat(
                directory.as_raw_fd(),
                temporary.as_ptr(),
                directory.as_raw_fd(),
                target.as_ptr(),
            )
        } < 0
        {
            return Err(persistence_error());
        }
        // Namespace commit has happened. A subsequent durability failure cannot
        // truthfully be returned as a failed transaction and rolled back in memory.
        let _ = directory.sync_all();
        Ok(())
    })();
    unsafe { unlinkat(directory.as_raw_fd(), temporary.as_ptr(), 0) };
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Profile(std::path::PathBuf);
    impl Profile {
        fn new() -> Self {
            let base = std::fs::canonicalize(std::env::temp_dir()).unwrap();
            let path = base.join(format!(
                "noltri-shortcuts-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            Self(path)
        }
        fn write(&self, bytes: &[u8]) {
            let file = self.0.join("shortcuts.json");
            std::fs::write(&file, bytes).unwrap();
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
    impl Drop for Profile {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // Removing native validation must permit an unsafe key or too few modifiers.
    #[test]
    fn rejects_unsupported_keys_modifiers_and_duplicate_combinations() {
        for key in ["", "s", "SS", "1", "é"] {
            let mut bindings = ShortcutBindings::default();
            bindings.screenshot.key = key.into();
            assert!(bindings.validate().is_err(), "accepted {key}");
        }
        let mut bindings = ShortcutBindings::default();
        bindings.screenshot.alt = false;
        bindings.screenshot.meta = false;
        assert!(bindings.validate().is_err());
        bindings.screenshot = bindings.open_intake.clone();
        assert!(bindings.validate().is_err());
        bindings.screenshot.shift = true;
        assert!(bindings.validate().is_ok());
    }

    // A missing atomic replacement or permissive output mode loses these observable guarantees.
    #[test]
    fn roundtrip_replaces_only_shortcuts_with_a_private_complete_document() {
        let profile = Profile::new();
        let mut bindings = ShortcutBindings::default();
        bindings.screenshot.key = "A".into();
        std::fs::write(profile.0.join("unrelated-sentinel"), b"unchanged").unwrap();
        save(&profile.0, &bindings).unwrap();
        assert_eq!(load(&profile.0).unwrap().screenshot.key, "A");
        assert_eq!(
            std::fs::metadata(profile.0.join("shortcuts.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        bindings.screenshot.key = "B".into();
        save(&profile.0, &bindings).unwrap();
        assert_eq!(load(&profile.0).unwrap().screenshot.key, "B");
        assert_eq!(
            std::fs::read(profile.0.join("unrelated-sentinel")).unwrap(),
            b"unchanged"
        );
        assert_eq!(std::fs::read_dir(&profile.0).unwrap().count(), 2);
        let json: serde_json::Value =
            serde_json::from_slice(&std::fs::read(profile.0.join("shortcuts.json")).unwrap())
                .unwrap();
        assert_eq!(json["openIntake"]["key"], "V");
    }

    // Falling back to defaults hides corrupt data and may seize unexpected global keys.
    #[test]
    fn malformed_and_oversized_existing_configuration_fail_closed() {
        let profile = Profile::new();
        for bytes in [b"{".to_vec(), vec![b' '; 4097], b"null".to_vec()] {
            profile.write(&bytes);
            assert!(load(&profile.0).is_err());
            assert_eq!(
                std::fs::read(profile.0.join("shortcuts.json")).unwrap(),
                bytes
            );
        }
    }

    // Following either link would expose an unrelated document to replacement or reads.
    #[test]
    fn linked_files_are_rejected_without_altering_the_target() {
        for hard in [false, true] {
            let profile = Profile::new();
            let target = profile.0.join("other-document");
            std::fs::write(&target, b"untouched").unwrap();
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600)).unwrap();
            let link = profile.0.join("shortcuts.json");
            if hard {
                std::fs::hard_link(&target, &link).unwrap();
            } else {
                symlink(&target, &link).unwrap();
            }
            assert!(load(&profile.0).is_err());
            assert!(save(&profile.0, &ShortcutBindings::default()).is_err());
            assert_eq!(std::fs::read(&target).unwrap(), b"untouched");
        }
    }

    // Looking only at 0777 accepts special bits outside the exact private mode.
    #[test]
    fn special_permission_bits_are_rejected_without_replacement() {
        let profile = Profile::new();
        let bytes = serde_json::to_vec(&ShortcutBindings::default()).unwrap();
        profile.write(&bytes);
        let target = profile.0.join("shortcuts.json");
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o1600)).unwrap();
        assert_eq!(
            std::fs::metadata(&target).unwrap().permissions().mode() & 0o7777,
            0o1600,
            "fixture must retain special bit"
        );
        assert!(load(&profile.0).is_err());
        assert!(save(&profile.0, &ShortcutBindings::default()).is_err());
        assert_eq!(std::fs::read(target).unwrap(), bytes);
    }

    // umask is scoped to a fresh test child, never the host or parallel tests.
    // A restrictive creation mask must fail before publication, preserving old bytes.
    #[test]
    fn restrictive_creation_mask_fails_before_commit_and_cleans_temporary_file() {
        const MARKER: &str = "NOLTRI_SHORTCUT_SETTINGS_UMASK_CHILD";
        if let Some(path) = std::env::var_os(MARKER) {
            unsafe extern "C" {
                fn umask(mask: u16) -> u16;
            }
            unsafe {
                umask(0o777);
            }
            let mut bindings = ShortcutBindings::default();
            bindings.screenshot.key = "A".into();
            assert_eq!(
                save(Path::new(&path), &bindings).unwrap_err(),
                "shortcut_persistence_failed"
            );
            return;
        }
        let profile = Profile::new();
        let before = serde_json::to_vec(&ShortcutBindings::default()).unwrap();
        profile.write(&before);
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "shortcut_settings::tests::restrictive_creation_mask_fails_before_commit_and_cleans_temporary_file", "--nocapture"])
            .env(MARKER, &profile.0).output().unwrap();
        assert!(
            child.status.success(),
            "{}{}",
            String::from_utf8_lossy(&child.stdout),
            String::from_utf8_lossy(&child.stderr)
        );
        assert_eq!(
            std::fs::read(profile.0.join("shortcuts.json")).unwrap(),
            before
        );
        assert_eq!(std::fs::read_dir(&profile.0).unwrap().count(), 1);
    }

    #[test]
    fn public_files_and_linked_profile_directories_are_rejected() {
        let profile = Profile::new();
        profile.write(b"{}");
        std::fs::set_permissions(
            profile.0.join("shortcuts.json"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(load(&profile.0).is_err());
        assert!(save(&profile.0, &ShortcutBindings::default()).is_err());
        let outer = Profile::new();
        let link = outer.0.join("linked-profile");
        symlink(&profile.0, &link).unwrap();
        assert!(load(&link).is_err());
        assert!(save(&link, &ShortcutBindings::default()).is_err());
    }
}
