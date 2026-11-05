//! Host ownership is scoped to one private settings/profile directory.
//! Independent explicit profiles may coexist; this is not a system-wide process lock.
use std::fs::{File, TryLockError};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

// Darwin flags, matching the existing secure settings-directory implementation.
const RDWR: i32 = 2;
const CREATE: i32 = 0x200;
const EXCLUSIVE: i32 = 0x800;
const NOFOLLOW: i32 = 0x100;
const CLOEXEC: i32 = 0x1000000;
const NONBLOCK: i32 = 4;

unsafe extern "C" {
    fn openat(fd: i32, path: *const std::ffi::c_char, flags: i32, ...) -> i32;
    fn geteuid() -> u32;
}

/// Retain for the host lifetime. Closing the file, including on process exit,
/// releases ownership without deleting or replacing the shared lock file.
#[must_use = "retain the guard for the host lifetime"]
pub struct InstanceGuard {
    _file: File,
}

/// Acquire before registering hotkeys or starting the runtime. `Ok(None)` means
/// another host currently owns this profile, not a stale PID-file heuristic.
pub fn acquire(path: &Path) -> Result<Option<InstanceGuard>, String> {
    let directory = crate::device_access::open_directory(path, true)?
        .ok_or("settings_directory_unavailable")?;
    // Atomically create one file, or open the existing winner without O_CREAT.
    // A loser reopens without another concurrent nonexclusive-create operation.
    // Never truncate or replace it. O_NONBLOCK prevents unsafe nonregular files
    // from blocking before their metadata can be checked.
    let flags = RDWR | NOFOLLOW | CLOEXEC | NONBLOCK;
    let mut fd = unsafe {
        openat(
            directory.as_raw_fd(),
            c".instance.lock".as_ptr(),
            flags | CREATE | EXCLUSIVE,
            0o600u32,
        )
    };
    if fd < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::AlreadyExists {
        fd = unsafe { openat(directory.as_raw_fd(), c".instance.lock".as_ptr(), flags) };
    }
    if fd < 0 {
        return Err("unsafe_instance_lock_file".into());
    }
    // SAFETY: openat returned a new owned descriptor; File closes it on every exit path.
    let file = unsafe { File::from_raw_fd(fd) };
    let metadata = file.metadata().map_err(|_| "unsafe_instance_lock_file")?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { geteuid() }
        || metadata.nlink() != 1
        || metadata.mode() & 0o7777 != 0o600
    {
        return Err("private_instance_lock_file_required".into());
    }
    match file.try_lock() {
        Ok(()) => Ok(Some(InstanceGuard { _file: file })),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(_)) => Err("instance_lock_failed".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, DirBuilder, OpenOptions};
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{symlink, DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::PathBuf;
    use std::process::{Child, Command, ExitStatus, Stdio};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{mpsc, Arc, Barrier};
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, Instant};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct Temp(PathBuf);

    impl Temp {
        fn new() -> Self {
            let base = fs::canonicalize(std::env::temp_dir()).unwrap();
            let path = base.join(format!(
                "noltri-instance-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            DirBuilder::new().mode(0o700).create(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn private_directory(path: &Path) {
        DirBuilder::new().mode(0o700).create(path).unwrap();
    }

    fn private_file(path: &Path, bytes: &[u8]) {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .unwrap()
            .write_all(bytes)
            .unwrap();
    }

    // A blocking implementation must fail a bounded test instead of hanging the suite.
    fn acquire_promptly(path: &Path) -> Result<Option<InstanceGuard>, String> {
        let path = path.to_owned();
        let (send, receive) = mpsc::channel();
        let worker = thread::spawn(move || {
            let _ = send.send(acquire(&path));
        });
        let result = receive
            .recv_timeout(Duration::from_secs(10))
            .expect("instance acquisition must be nonblocking");
        worker.join().unwrap();
        result
    }

    struct Holder {
        child: Child,
        output: Option<JoinHandle<()>>,
    }

    impl Holder {
        fn start(profile: &Path) -> Self {
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--ignored",
                    "--exact",
                    "instance::tests::lock_holder_process",
                    "--nocapture",
                ])
                .env("NOLTRI_INSTANCE_TEST_PROFILE", profile)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .spawn()
                .unwrap();
            let stdout = child.stdout.take().unwrap();
            let (send, receive) = mpsc::channel();
            let output = thread::spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    if line.contains("NOLTRI_INSTANCE_LOCK_HELD") {
                        let _ = send.send(());
                    }
                }
            });
            // Establish cleanup before waiting: a failed handshake must kill only this child.
            let holder = Self {
                child,
                output: Some(output),
            };
            receive
                .recv_timeout(Duration::from_secs(10))
                .expect("owned lock helper must report successful acquisition");
            holder
        }

        fn wait(&mut self) -> ExitStatus {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                if let Some(status) = self.child.try_wait().unwrap() {
                    return status;
                }
                assert!(Instant::now() < deadline, "owned lock helper did not exit");
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    impl Drop for Holder {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            if let Some(output) = self.output.take() {
                output.join().unwrap();
            }
        }
    }

    #[test]
    fn fresh_profile_acquires_and_creates_a_private_lock_file() {
        let temp = Temp::new();
        let profile = temp.0.join("profile");
        let guard = acquire(&profile).unwrap();
        assert!(guard.is_some(), "a fresh profile must acquire ownership");
        let metadata = fs::metadata(profile.join(".instance.lock")).unwrap();
        assert!(metadata.is_file());
        assert_eq!(metadata.uid(), fs::metadata(&temp.0).unwrap().uid());
        assert_eq!(metadata.mode() & 0o777, 0o600);
        assert_eq!(metadata.nlink(), 1);
        assert_eq!(metadata.len(), 0);
        assert_eq!(fs::read_dir(profile).unwrap().count(), 1);
    }

    #[test]
    fn holding_guard_rejects_duplicate_and_drop_allows_reacquisition() {
        let temp = Temp::new();
        let guard = acquire(&temp.0).unwrap();
        assert!(guard.is_some());
        assert!(acquire_promptly(&temp.0).unwrap().is_none());
        assert!(acquire_promptly(&temp.0.join(".")).unwrap().is_none());
        drop(guard);
        assert!(acquire(&temp.0).unwrap().is_some());
    }

    #[test]
    fn separate_explicit_profiles_can_hold_independent_locks() {
        let temp = Temp::new();
        let first = acquire(&temp.0.join("first")).unwrap();
        let second = acquire(&temp.0.join("second")).unwrap();
        assert!(first.is_some());
        assert!(second.is_some());
        assert!(acquire_promptly(&temp.0.join("first")).unwrap().is_none());
        assert!(acquire_promptly(&temp.0.join("second")).unwrap().is_none());
    }

    #[test]
    fn existing_contents_and_inode_survive_acquire_duplicate_and_release() {
        let temp = Temp::new();
        let lock = temp.0.join(".instance.lock");
        let contents = b"1\nobsolete pid data must not determine ownership\n";
        private_file(&lock, contents);
        let inode = fs::metadata(&lock).unwrap().ino();
        let guard = acquire(&temp.0).unwrap();
        assert!(
            guard.is_some(),
            "stale contents must not prevent acquisition"
        );
        assert!(acquire_promptly(&temp.0).unwrap().is_none());
        drop(guard);
        assert_eq!(fs::read(&lock).unwrap(), contents);
        assert_eq!(fs::metadata(&lock).unwrap().ino(), inode);
        assert!(acquire(&temp.0).unwrap().is_some());
        assert_eq!(fs::metadata(&lock).unwrap().ino(), inode);
    }

    #[test]
    fn symlink_lock_is_rejected_without_modifying_its_target() {
        let temp = Temp::new();
        let profile = temp.0.join("profile");
        private_directory(&profile);
        let target = temp.0.join("target");
        private_file(&target, b"untouched");
        symlink(&target, profile.join(".instance.lock")).unwrap();
        assert!(acquire(&profile).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"untouched");
        assert!(fs::symlink_metadata(profile.join(".instance.lock"))
            .unwrap()
            .is_symlink());
    }

    #[test]
    fn hardlinked_lock_is_rejected_without_modifying_either_name() {
        let temp = Temp::new();
        let profile = temp.0.join("profile");
        private_directory(&profile);
        let target = temp.0.join("target");
        private_file(&target, b"untouched");
        fs::hard_link(&target, profile.join(".instance.lock")).unwrap();
        assert!(acquire(&profile).is_err());
        assert_eq!(fs::read(&target).unwrap(), b"untouched");
        assert_eq!(fs::metadata(&target).unwrap().nlink(), 2);
    }

    #[test]
    fn directory_and_fifo_lock_files_are_rejected_promptly() {
        let temp = Temp::new();
        let lock = temp.0.join(".instance.lock");
        private_directory(&lock);
        assert!(acquire_promptly(&temp.0).is_err());
        assert!(lock.is_dir());
        fs::remove_dir(&lock).unwrap();
        unsafe extern "C" {
            fn mkfifo(path: *const std::ffi::c_char, mode: u16) -> i32;
        }
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(lock.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { mkfifo(path.as_ptr(), 0o600) }, 0);
        assert!(acquire_promptly(&temp.0).is_err());
        use std::os::unix::fs::FileTypeExt;
        assert!(fs::metadata(lock).unwrap().file_type().is_fifo());
    }

    #[test]
    fn lock_permissions_must_be_exactly_private_without_repairing_the_file() {
        let temp = Temp::new();
        let lock = temp.0.join(".instance.lock");
        private_file(&lock, b"preserve");
        for mode in [0o644, 0o660, 0o400, 0o000, 0o700, 0o1600] {
            fs::set_permissions(&lock, fs::Permissions::from_mode(mode)).unwrap();
            assert_eq!(fs::metadata(&lock).unwrap().mode() & 0o7777, mode);
            assert!(acquire(&temp.0).is_err(), "unsafe mode {mode:o}");
            assert_eq!(fs::metadata(&lock).unwrap().mode() & 0o7777, mode);
        }
        fs::set_permissions(&lock, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(fs::read(&lock).unwrap(), b"preserve");
        assert!(acquire(&temp.0).unwrap().is_some());
    }

    #[test]
    fn unsafe_profile_paths_are_rejected_before_creating_a_lock() {
        let temp = Temp::new();
        let profile = temp.0.join("profile");
        private_directory(&profile);
        let alias = temp.0.join("alias");
        symlink(&profile, &alias).unwrap();
        assert!(acquire(&alias).is_err());
        assert!(acquire(&temp.0.join("profile/../other")).is_err());
        assert!(acquire(Path::new("relative-instance-test-profile")).is_err());
        fs::set_permissions(&profile, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(acquire(&profile).is_err());
        assert!(!profile.join(".instance.lock").exists());
        assert!(!temp.0.join("other").exists());
    }

    #[test]
    fn guard_descriptor_is_close_on_exec_and_nonblocking() {
        let temp = Temp::new();
        let guard = acquire(&temp.0).unwrap().expect("fresh lock");
        unsafe extern "C" {
            fn fcntl(fd: i32, command: i32, ...) -> i32;
        }
        // Darwin F_GETFD = 1, FD_CLOEXEC = 1, F_GETFL = 3, O_NONBLOCK = 4.
        let fd = guard._file.as_raw_fd();
        assert_eq!(unsafe { fcntl(fd, 1) } & 1, 1);
        assert_eq!(unsafe { fcntl(fd, 3) } & 4, 4);
    }

    #[test]
    fn concurrent_acquisition_has_exactly_one_owner() {
        let temp = Temp::new();
        let gate = Arc::new(Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let path = temp.0.join("profile");
                let gate = gate.clone();
                thread::spawn(move || {
                    gate.wait();
                    acquire(&path)
                })
            })
            .collect();
        // Retain all results until counted; otherwise dropping a winner permits the next owner.
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        let errors: Vec<_> = results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .collect();
        assert!(errors.is_empty(), "concurrent startup failed: {errors:?}");
        assert_eq!(
            results
                .iter()
                .filter(|guard| matches!(guard, Ok(Some(_))))
                .count(),
            1
        );
        assert_eq!(fs::read_dir(temp.0.join("profile")).unwrap().count(), 1);
    }

    #[test]
    fn process_owner_blocks_duplicate_and_normal_exit_allows_reacquisition() {
        let temp = Temp::new();
        let mut holder = Holder::start(&temp.0);
        assert!(acquire_promptly(&temp.0).unwrap().is_none());
        holder.child.stdin.take().unwrap().write_all(b"x").unwrap();
        assert!(holder.wait().success());
        assert!(acquire(&temp.0).unwrap().is_some());
    }

    #[test]
    fn killing_only_the_owned_helper_releases_its_lock_without_deleting_the_file() {
        let temp = Temp::new();
        let mut holder = Holder::start(&temp.0);
        let lock = temp.0.join(".instance.lock");
        let inode = fs::metadata(&lock).unwrap().ino();
        assert!(acquire_promptly(&temp.0).unwrap().is_none());
        holder.child.kill().unwrap();
        assert!(!holder.wait().success());
        assert_eq!(fs::metadata(&lock).unwrap().ino(), inode);
        assert!(acquire(&temp.0).unwrap().is_some());
        assert_eq!(fs::metadata(&lock).unwrap().ino(), inode);
    }

    #[test]
    #[ignore = "owned helper, launched only by the cross-process instance tests"]
    fn lock_holder_process() {
        let profile = std::env::var_os("NOLTRI_INSTANCE_TEST_PROFILE")
            .expect("owned helper requires its synthetic profile");
        let _guard = acquire(Path::new(&profile))
            .unwrap()
            .expect("owned helper must acquire its fresh profile");
        println!("NOLTRI_INSTANCE_LOCK_HELD");
        std::io::stdout().flush().unwrap();
        std::io::stdin().read_exact(&mut [0u8; 1]).unwrap();
    }
}
