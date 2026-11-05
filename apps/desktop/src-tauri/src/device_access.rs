//! Local device access credential. No Debug/Serialize: never include this value in diagnostics.
use std::ffi::CString;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path};
use std::sync::atomic::{AtomicU64, Ordering};

pub struct DeviceAccess(String);
impl DeviceAccess {
    pub fn token(&self) -> &str {
        &self.0
    }
}

const TOKEN_FILE: &str = ".device-access-token";
const NOFOLLOW: i32 = 0x100;
const DIRECTORY: i32 = 0x100000;
const CLOEXEC: i32 = 0x1000000;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
unsafe extern "C" {
    fn openat(fd: i32, path: *const std::ffi::c_char, flags: i32, ...) -> i32;
    fn mkdirat(fd: i32, path: *const std::ffi::c_char, mode: u16) -> i32;
    fn unlinkat(fd: i32, path: *const std::ffi::c_char, flags: i32) -> i32;
    fn renameatx_np(
        from_fd: i32,
        from: *const std::ffi::c_char,
        to_fd: i32,
        to: *const std::ffi::c_char,
        flags: u32,
    ) -> i32;
    fn geteuid() -> u32;
}

pub fn validate_token(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > 4096 || !value.bytes().all(|b| (33..=126).contains(&b)) {
        return Err("invalid_device_access_credential".into());
    }
    Ok(())
}

fn name(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| "invalid_settings_path".into())
}
pub(crate) fn open_directory(path: &Path, create: bool) -> Result<Option<File>, String> {
    if !path.is_absolute() {
        return Err("absolute_settings_directory_required".into());
    }
    let mut directory = File::open("/").map_err(|_| "settings_directory_unavailable")?;
    let mut count = 0;
    for part in path.components() {
        let component = match part {
            Component::RootDir => continue,
            Component::Normal(value) => value,
            _ => return Err("unsafe_settings_directory".into()),
        };
        count += 1;
        let component = name(component.to_str().ok_or("invalid_settings_path")?)?;
        let flags = DIRECTORY | NOFOLLOW | CLOEXEC;
        let mut fd = unsafe { openat(directory.as_raw_fd(), component.as_ptr(), flags) };
        if fd < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
            if !create {
                return Ok(None);
            }
            let made = unsafe { mkdirat(directory.as_raw_fd(), component.as_ptr(), 0o700) };
            if made < 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return Err("settings_directory_create_failed".into());
            }
            fd = unsafe { openat(directory.as_raw_fd(), component.as_ptr(), flags) };
        }
        if fd < 0 {
            return Err("unsafe_settings_directory".into());
        }
        directory = unsafe { File::from_raw_fd(fd) };
    }
    if count == 0 {
        return Err("unsafe_settings_directory".into());
    }
    let meta = directory
        .metadata()
        .map_err(|_| "settings_directory_unavailable")?;
    if !meta.is_dir() || meta.uid() != unsafe { geteuid() } || meta.mode() & 0o777 != 0o700 {
        return Err("private_settings_directory_required".into());
    }
    Ok(Some(directory))
}

/// Read only an owned, private regular settings file through the validated directory descriptor.
pub fn read_settings(path: &Path, create: bool) -> Result<Option<Vec<u8>>, String> {
    let Some(directory) = open_directory(path, create)? else {
        return Ok(None);
    };
    let filename = name("settings.json")?;
    let fd = unsafe {
        openat(
            directory.as_raw_fd(),
            filename.as_ptr(),
            NOFOLLOW | CLOEXEC | 4,
        )
    };
    if fd < 0 {
        return if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err("unsafe_settings_file".into())
        };
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let meta = file.metadata().map_err(|_| "unsafe_settings_file")?;
    if !meta.is_file()
        || meta.uid() != unsafe { geteuid() }
        || meta.nlink() != 1
        || meta.mode() & 0o077 != 0
        || meta.len() > 4 * 1024 * 1024
    {
        return Err("private_settings_file_required".into());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "settings_read_failed")?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("settings_read_failed".into());
    }
    Ok(Some(bytes))
}

fn read_token(directory: &File) -> Result<Option<String>, String> {
    let filename = name(TOKEN_FILE)?;
    let fd = unsafe {
        openat(
            directory.as_raw_fd(),
            filename.as_ptr(),
            NOFOLLOW | CLOEXEC | 4,
        )
    };
    if fd < 0 {
        return if std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err("unsafe_device_access_file".into())
        };
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let meta = file.metadata().map_err(|_| "device_access_read_failed")?;
    if !meta.is_file()
        || meta.uid() != unsafe { geteuid() }
        || meta.mode() & 0o777 != 0o600
        || meta.nlink() != 1
        || meta.len() != 64
    {
        return Err("invalid_device_access_file".into());
    }
    let mut value = String::new();
    Read::by_ref(&mut file)
        .take(65)
        .read_to_string(&mut value)
        .map_err(|_| "device_access_read_failed")?;
    let after = file.metadata().map_err(|_| "device_access_read_failed")?;
    if value.len() != 64
        || !value.bytes().all(|b| b.is_ascii_hexdigit())
        || meta.mtime() != after.mtime()
        || meta.mtime_nsec() != after.mtime_nsec()
        || after.len() != 64
    {
        return Err("invalid_device_access_file".into());
    }
    Ok(Some(value))
}

fn random_hex() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|_| "device_access_random_failed")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn publish_token(directory: &File) -> Result<String, String> {
    let token = random_hex()?;
    let temporary = name(&format!(
        ".device-access-pending-{}-{}",
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
        return Err("device_access_create_failed".into());
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let result = (|| {
        file.write_all(token.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|_| "device_access_write_failed")?;
        let target = name(TOKEN_FILE)?;
        // macOS RENAME_EXCL publishes a complete file atomically and never overwrites a winner.
        let published = unsafe {
            renameatx_np(
                directory.as_raw_fd(),
                temporary.as_ptr(),
                directory.as_raw_fd(),
                target.as_ptr(),
                4,
            )
        };
        if published < 0
            && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
        {
            return Err("device_access_publish_failed".into());
        }
        directory
            .sync_all()
            .map_err(|_| "device_access_sync_failed")?;
        read_token(directory)?.ok_or_else(|| "device_access_read_failed".into())
    })();
    unsafe { unlinkat(directory.as_raw_fd(), temporary.as_ptr(), 0) };
    result
}

pub fn resolve(
    path: &Path,
    saved: &str,
    access: Option<&str>,
    dev: Option<&str>,
    generate: bool,
) -> Result<DeviceAccess, String> {
    let mut explicit: Option<&str> = None;
    for value in [Some(saved), access, dev]
        .into_iter()
        .flatten()
        .filter(|value| !value.is_empty())
    {
        validate_token(value)?;
        if explicit.is_some_and(|prior| prior != value) {
            return Err("conflicting_device_access_credentials".into());
        }
        explicit = Some(value);
    }
    let directory = open_directory(path, generate)?;
    let existing = match directory.as_ref() {
        Some(dir) => read_token(dir)?,
        None => None,
    };
    if let Some(value) = explicit {
        if existing.as_deref().is_some_and(|prior| prior != value) {
            return Err("conflicting_device_access_credentials".into());
        }
        return Ok(DeviceAccess(value.to_owned()));
    }
    if !generate {
        return Err("explicit_device_access_credential_required".into());
    }
    match existing {
        Some(value) => Ok(DeviceAccess(value)),
        None => Ok(DeviceAccess(publish_token(
            directory.as_ref().ok_or("settings_directory_unavailable")?,
        )?)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    fn temp() -> std::path::PathBuf {
        let base = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let path = base.join(format!(
            "noltri-device-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }
    #[test]
    fn managed_profile_generates_reuses_private_token_without_debug_output() {
        let base = temp();
        let dir = base.join("profile");
        let first = resolve(&dir, "", None, None, true).unwrap();
        let second = resolve(&dir, "", None, None, true).unwrap();
        assert!(first.token() == second.token());
        assert!(first.token().len() == 64 && first.token().bytes().all(|v| v.is_ascii_hexdigit()));
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(dir.join(".device-access-token"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        std::fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn managed_profile_rejects_conflicting_explicit_credentials_and_header_injection() {
        let base = temp();
        let dir = base.join("absent");
        assert!(resolve(&dir, "synthetic-a", Some("synthetic-b"), None, false).is_err());
        assert!(resolve(&dir, "", Some("synthetic-a"), Some("synthetic-b"), false).is_err());
        for invalid in ["bad\r\nHeader:value", "bad token", "\t", "é"] {
            assert!(resolve(&dir, invalid, None, None, false).is_err());
        }
        assert!(resolve(&dir, "", None, None, false).is_err());
        let access = resolve(
            &dir,
            "synthetic-a",
            Some("synthetic-a"),
            Some("synthetic-a"),
            false,
        )
        .unwrap();
        assert!(access.token() == "synthetic-a");
        assert!(!dir.exists());
        std::fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn managed_profile_preserves_existing_token_and_rejects_partial_or_unsafe_files() {
        let base = temp();
        let dir = base.join("profile");
        let access = resolve(&dir, "", None, None, true).unwrap();
        assert!(resolve(&dir, "other-explicit-token", None, None, true).is_err());
        assert!(
            std::fs::read_to_string(dir.join(".device-access-token")).unwrap() == access.token()
        );
        std::fs::write(dir.join(".device-access-token"), "partial").unwrap();
        assert!(resolve(&dir, "", None, None, true).is_err());
        assert!(std::fs::read_to_string(dir.join(".device-access-token")).unwrap() == "partial");
        std::fs::set_permissions(
            dir.join(".device-access-token"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(resolve(&dir, "", None, None, true).is_err());
        std::fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn managed_profile_rejects_symlink_root_file_and_unsafe_directory() {
        let base = temp();
        let real = base.join("real");
        std::fs::create_dir(&real).unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o700)).unwrap();
        symlink(&real, base.join("alias")).unwrap();
        assert!(resolve(&base.join("alias"), "", None, None, true).is_err());
        let target = base.join("target");
        std::fs::write(&target, "untouched").unwrap();
        symlink(&target, real.join(".device-access-token")).unwrap();
        assert!(resolve(&real, "", None, None, true).is_err());
        assert!(std::fs::read_to_string(&target).unwrap() == "untouched");
        std::fs::remove_file(real.join(".device-access-token")).unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(resolve(&real, "", None, None, true).is_err());
        std::fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn managed_profile_concurrent_creation_publishes_one_complete_value() {
        let base = temp();
        let dir = base.join("profile");
        let gate = std::sync::Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let dir = dir.clone();
                let gate = gate.clone();
                std::thread::spawn(move || {
                    gate.wait();
                    resolve(&dir, "", None, None, true).map(|v| v.token().to_owned())
                })
            })
            .collect();
        let values: Vec<_> = threads
            .into_iter()
            .map(|t| t.join().unwrap().unwrap())
            .collect();
        assert!(values.iter().all(|v| v == &values[0]));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(base).unwrap();
    }
    #[test]
    fn managed_profile_rejects_hardlinks_nonregular_tokens_and_unsafe_settings() {
        let base = temp();
        let dir = base.join("profile");
        let access = resolve(&dir, "", None, None, true).unwrap();
        std::fs::hard_link(dir.join(TOKEN_FILE), base.join("linked-token")).unwrap();
        assert!(resolve(&dir, "", None, None, true).is_err());
        std::fs::remove_file(base.join("linked-token")).unwrap();
        std::fs::remove_file(dir.join(TOKEN_FILE)).unwrap();
        std::fs::create_dir(dir.join(TOKEN_FILE)).unwrap();
        assert!(resolve(&dir, "", None, None, true).is_err());
        std::fs::remove_dir(dir.join(TOKEN_FILE)).unwrap();
        unsafe extern "C" {
            fn mkfifo(path: *const std::ffi::c_char, mode: u16) -> i32;
        }
        let fifo = name(dir.join(TOKEN_FILE).to_str().unwrap()).unwrap();
        assert_eq!(unsafe { mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert!(resolve(&dir, "", None, None, true).is_err());
        std::fs::remove_file(dir.join(TOKEN_FILE)).unwrap();
        std::fs::write(dir.join("settings.json"), b"{}").unwrap();
        std::fs::set_permissions(
            dir.join("settings.json"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(read_settings(&dir, false).is_err());
        std::fs::set_permissions(
            dir.join("settings.json"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        assert!(read_settings(&dir, false).unwrap().is_some());
        assert!(access.token().len() == 64);
        std::fs::remove_dir_all(base).unwrap();
    }
}
