//! Only handles returned by our spawn enter this ledger. Never discovers processes by PID.
use serde::Serialize;

const HISTORY_LIMIT: usize = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChildRole {
    Core,
    Mcp,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChildState {
    Running,
    StopRequested,
    KillFailed,
    ObservationFailed,
    Terminated,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum KillOutcome {
    Accepted,
    Failed,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildDiagnostics {
    pub role: ChildRole,
    pub pid: u32,
    pub generation: u64,
    pub state: ChildState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_signal: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kill_outcome: Option<KillOutcome>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChildExit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

pub trait ChildControl {
    fn pid(&self) -> u32;
    fn kill(&mut self) -> Result<(), ()>;
    fn try_wait(&mut self) -> Result<Option<ChildExit>, ()>;
}
struct OwnedChild<H> {
    metadata: ChildDiagnostics,
    handle: Option<H>,
}
pub struct ChildLedger<H> {
    pub generation: u64,
    pub shutting_down: bool,
    children: Vec<OwnedChild<H>>,
}
impl<H> Default for ChildLedger<H> {
    fn default() -> Self {
        Self {
            generation: 0,
            shutting_down: false,
            children: Vec::new(),
        }
    }
}
impl<H: ChildControl> ChildLedger<H> {
    pub fn begin_generation(&mut self) -> Result<u64, ()> {
        if self.unconfirmed() != 0 {
            return Err(());
        }
        self.generation += 1;
        self.shutting_down = false;
        Ok(self.generation)
    }
    pub fn add(&mut self, role: ChildRole, generation: u64, handle: H) {
        // Evict completed records only. A live owned handle is never pruned.
        while self.children.len() >= HISTORY_LIMIT {
            let Some(index) = self
                .children
                .iter()
                .position(|entry| entry.handle.is_none())
            else {
                break;
            };
            self.children.remove(index);
        }
        let metadata = ChildDiagnostics {
            role,
            pid: handle.pid(),
            generation,
            state: ChildState::Running,
            exit_code: None,
            exit_signal: None,
            kill_outcome: None,
        };
        log_child("spawn", &metadata);
        self.children.push(OwnedChild {
            metadata,
            handle: Some(handle),
        });
    }
    pub fn request_stop(&mut self) {
        self.generation += 1; // Invalidates in-flight readiness before sending any kill.
        self.shutting_down = true;
        for entry in &mut self.children {
            let Some(handle) = entry.handle.as_mut() else {
                continue;
            };
            if entry.metadata.kill_outcome == Some(KillOutcome::Accepted) {
                continue;
            }
            match handle.kill() {
                Ok(()) => {
                    entry.metadata.state = ChildState::StopRequested;
                    entry.metadata.kill_outcome = Some(KillOutcome::Accepted);
                }
                Err(()) => {
                    entry.metadata.state = ChildState::KillFailed;
                    entry.metadata.kill_outcome = Some(KillOutcome::Failed);
                }
            }
            log_child("kill", &entry.metadata);
        }
    }
    pub fn observe(&mut self) -> bool {
        let mut exits = Vec::new();
        for entry in &mut self.children {
            let Some(handle) = entry.handle.as_mut() else {
                continue;
            };
            match handle.try_wait() {
                Ok(Some(exit)) => exits.push((
                    entry.metadata.role,
                    entry.metadata.pid,
                    entry.metadata.generation,
                    exit,
                )),
                Ok(None) => {}
                Err(()) => {
                    if entry.metadata.state != ChildState::ObservationFailed {
                        entry.metadata.state = ChildState::ObservationFailed;
                        log_child("observationFailed", &entry.metadata);
                    }
                }
            }
        }
        let mut current_terminated = false;
        for (role, pid, generation, exit) in exits {
            current_terminated |= self.record_termination(role, pid, generation, exit);
        }
        current_terminated
    }
    pub fn record_termination(
        &mut self,
        role: ChildRole,
        pid: u32,
        generation: u64,
        exit: ChildExit,
    ) -> bool {
        let Some(entry) = self.children.iter_mut().find(|entry| {
            entry.metadata.role == role
                && entry.metadata.pid == pid
                && entry.metadata.generation == generation
                && entry.handle.is_some()
        }) else {
            return false;
        };
        // Record first, even when stop has already invalidated this generation.
        entry.metadata.state = ChildState::Terminated;
        entry.metadata.exit_code = exit.code;
        entry.metadata.exit_signal = exit.signal;
        entry.handle.take();
        log_child("termination", &entry.metadata);
        generation == self.generation && !self.shutting_down
    }
    pub fn diagnostics(&self) -> Vec<ChildDiagnostics> {
        self.children
            .iter()
            .map(|entry| entry.metadata.clone())
            .collect()
    }
    pub fn unconfirmed(&self) -> usize {
        self.children
            .iter()
            .filter(|entry| entry.handle.is_some())
            .count()
    }
    pub fn kill_failed(&self) -> bool {
        self.children.iter().any(|entry| {
            entry.handle.is_some() && entry.metadata.kill_outcome == Some(KillOutcome::Failed)
        })
    }
}

fn log_child(event: &str, child: &ChildDiagnostics) {
    // All fields are own identity or finite enums; never include command, output, errors or paths.
    eprintln!("noltri_runtime event={event} appPid={} role={:?} pid={} generation={} state={:?} killOutcome={:?} exitCode={:?} exitSignal={:?}",
        std::process::id(), child.role, child.pid, child.generation, child.state,
        child.kill_outcome, child.exit_code, child.exit_signal);
}

#[cfg(test)]
mod tests {
    use super::*;
    // Only OS kill/wait are replaced: the ledger, generation and serialization remain real.
    #[derive(Debug)]
    struct ChildFixture {
        pid: u32,
        kill_fails: bool,
        exit: Option<ChildExit>,
        wait_fails: bool,
    }
    impl ChildControl for ChildFixture {
        fn pid(&self) -> u32 {
            self.pid
        }
        fn kill(&mut self) -> Result<(), ()> {
            if self.kill_fails {
                Err(())
            } else {
                Ok(())
            }
        }
        fn try_wait(&mut self) -> Result<Option<ChildExit>, ()> {
            if self.wait_fails {
                Err(())
            } else {
                Ok(self.exit)
            }
        }
    }
    fn running(pid: u32) -> ChildFixture {
        ChildFixture {
            pid,
            kill_fails: false,
            exit: None,
            wait_fails: false,
        }
    }
    fn ledger() -> ChildLedger<ChildFixture> {
        let mut ledger = ChildLedger::default();
        ledger.generation = 1;
        ledger.children.push(OwnedChild {
            metadata: ChildDiagnostics {
                role: ChildRole::Core,
                pid: 101,
                generation: 1,
                state: ChildState::Running,
                exit_code: None,
                exit_signal: None,
                kill_outcome: None,
            },
            handle: Some(running(101)),
        });
        ledger
    }
    // A kill acknowledgment substituted for termination would falsely confirm shutdown.
    #[test]
    fn owned_accepted_kill_keeps_child_unconfirmed_until_observed_exit() {
        let mut ledger = ledger();
        ledger.request_stop();
        assert_eq!(ledger.unconfirmed(), 1);
        assert_eq!(ledger.diagnostics()[0].state, ChildState::StopRequested);
        assert_eq!(
            ledger.diagnostics()[0].kill_outcome,
            Some(KillOutcome::Accepted)
        );
        assert!(!ledger.observe());
        assert_eq!(ledger.unconfirmed(), 1);
    }
    // Draining or consuming a failed kill loses the only retryable handle.
    #[test]
    fn owned_failed_kill_retains_handle_and_can_retry_without_claiming_exit() {
        let mut ledger = ledger();
        ledger.children[0].handle.as_mut().unwrap().kill_fails = true;
        ledger.request_stop();
        assert!(ledger.kill_failed());
        assert_eq!(ledger.unconfirmed(), 1);
        assert_eq!(ledger.diagnostics()[0].state, ChildState::KillFailed);
        ledger.children[0].handle.as_mut().unwrap().kill_fails = false;
        ledger.request_stop();
        assert_eq!(
            ledger.diagnostics()[0].kill_outcome,
            Some(KillOutcome::Accepted)
        );
        assert_eq!(ledger.unconfirmed(), 1);
    }
    // Filtering by the invalidated generation before recording would lose this evidence.
    #[test]
    fn owned_old_generation_exit_is_recorded_with_actual_code_and_signal() {
        let mut ledger = ledger();
        ledger.request_stop();
        ledger.children[0].handle.as_mut().unwrap().exit = Some(ChildExit {
            code: None,
            signal: Some(9),
        });
        assert!(!ledger.observe());
        assert_eq!(ledger.unconfirmed(), 0);
        let child = &ledger.diagnostics()[0];
        assert_eq!(child.generation, 1);
        assert_eq!(child.pid, 101);
        assert_eq!(child.state, ChildState::Terminated);
        assert_eq!(child.exit_code, None);
        assert_eq!(child.exit_signal, Some(9));
        assert!(ledger.children[0].handle.is_none());
    }
    // Port availability is insufficient; a live owned handle must prevent restart.
    #[test]
    fn owned_restart_waits_for_exit_even_after_kill_is_accepted() {
        let mut ledger = ledger();
        ledger.request_stop();
        assert!(ledger.begin_generation().is_err());
        ledger.record_termination(
            ChildRole::Core,
            101,
            1,
            ChildExit {
                code: Some(0),
                signal: None,
            },
        );
        assert_eq!(ledger.begin_generation(), Ok(3));
        assert!(!ledger.shutting_down);
    }
    // A late or duplicated old exit must never stop the current generation.
    #[test]
    fn owned_late_termination_does_not_affect_new_generation_or_reused_pid() {
        let mut ledger = ledger();
        assert!(ledger.record_termination(
            ChildRole::Core,
            101,
            1,
            ChildExit {
                code: Some(7),
                signal: None
            }
        ));
        let generation = ledger.begin_generation().unwrap();
        ledger.add(ChildRole::Core, generation, running(101));
        assert!(!ledger.record_termination(
            ChildRole::Core,
            101,
            1,
            ChildExit {
                code: Some(99),
                signal: None
            }
        ));
        let children = ledger.diagnostics();
        assert_eq!(children[0].exit_code, Some(7));
        assert_eq!(children[1].state, ChildState::Running);
        assert_eq!(children[1].kill_outcome, None);
        assert_eq!(ledger.unconfirmed(), 1);
    }
    // Wait failure must retain ownership rather than silently inferring an exit.
    #[test]
    fn owned_wait_failure_blocks_restart_and_preserves_handle() {
        let mut ledger = ledger();
        ledger.children[0].handle.as_mut().unwrap().wait_fails = true;
        assert!(!ledger.observe());
        assert_eq!(ledger.diagnostics()[0].state, ChildState::ObservationFailed);
        assert_eq!(ledger.unconfirmed(), 1);
        assert!(ledger.begin_generation().is_err());
        assert!(ledger.children[0].handle.is_some());
    }
    // Unbounded completed sessions would make diagnostic payloads grow forever.
    #[test]
    fn owned_history_is_bounded_without_removing_live_children() {
        let mut ledger = ChildLedger::default();
        for pid in 1..=40 {
            let generation = ledger.begin_generation().unwrap();
            ledger.add(ChildRole::Core, generation, running(pid));
            ledger.record_termination(
                ChildRole::Core,
                pid,
                generation,
                ChildExit {
                    code: Some(0),
                    signal: None,
                },
            );
        }
        let generation = ledger.begin_generation().unwrap();
        ledger.add(ChildRole::Mcp, generation, running(999));
        assert!(ledger.diagnostics().len() <= 16);
        assert_eq!(ledger.unconfirmed(), 1);
        assert_eq!(ledger.diagnostics().last().unwrap().pid, 999);
    }
    // The bounded stop driver must report unconfirmed ownership when a kill was only accepted.
    #[test]
    fn owned_stop_driver_times_out_without_fabricating_exit_after_accepted_kill() {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut ledger = ledger();
            ledger.request_stop();
            let report =
                super::super::wait_for_owned_shutdown(std::time::Duration::from_millis(25), || {
                    ledger.observe();
                    (ledger.unconfirmed(), ledger.kill_failed())
                });
            tx.send(report).unwrap();
        });
        let report = rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("bounded stop must return");
        assert_eq!(report.outcome, super::super::RuntimeStopOutcome::TimedOut);
        assert!(!report.shutdown_confirmed);
        assert_eq!(report.unconfirmed_children, 1);
    }
    // Failed signaling is a distinct result, rather than a timeout or success.
    #[test]
    fn owned_stop_driver_distinguishes_failed_kill_and_confirms_later_actual_exit() {
        let mut ledger = ledger();
        ledger.children[0].handle.as_mut().unwrap().kill_fails = true;
        ledger.request_stop();
        let report = super::super::wait_for_owned_shutdown(std::time::Duration::ZERO, || {
            ledger.observe();
            (ledger.unconfirmed(), ledger.kill_failed())
        });
        assert_eq!(report.outcome, super::super::RuntimeStopOutcome::KillFailed);
        assert!(!report.shutdown_confirmed);
        assert_eq!(report.unconfirmed_children, 1);
        ledger.record_termination(
            ChildRole::Core,
            101,
            1,
            ChildExit {
                code: Some(0),
                signal: None,
            },
        );
        let report = super::super::wait_for_owned_shutdown(std::time::Duration::ZERO, || {
            ledger.observe();
            (ledger.unconfirmed(), ledger.kill_failed())
        });
        assert_eq!(report.outcome, super::super::RuntimeStopOutcome::Confirmed);
        assert!(report.shutdown_confirmed);
        assert_eq!(report.unconfirmed_children, 0);
    }
}
