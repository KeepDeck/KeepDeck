//! One run per key at a time, for work a plugin asks the host to perform.
//!
//! A plugin knows what its CLI needs and when; it cannot spawn a process,
//! so it hands the work over and the host performs it. This module is the
//! whole of the host's side: SINGLE-FLIGHT plus [`crate::run_bounded`]'s
//! discipline. It knows nothing about which CLI is running or why — every
//! judgement about whether the work is needed at all belongs to the caller.
//!
//! SINGLE-FLIGHT, not run-once-ever. The distinction is the design:
//!
//! - Run-once-ever needs a memory of what has been done, and that memory
//!   lies the moment the work is undone outside us (a directory wiped, a
//!   tool upgraded). We would then refuse the very run that is needed.
//! - Single-flight remembers only what is happening RIGHT NOW. A caller
//!   arriving mid-run waits for it and takes its result instead of starting
//!   a second one; a caller arriving after it finished starts a fresh run —
//!   which is correct, because by then it has re-judged the world itself.
//!
//! That is what makes the plugin the only judge. It asks "is this needed?",
//! and if two panes ask at the same moment, exactly one run happens and both
//! learn how it went. Nothing here has to know what "needed" means.

use std::collections::HashMap;
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;

use crate::keyed_locks::{KeyedLocks, PoisonPolicy};

/// How one request resolved. `joined` is not a failure and not a refusal:
/// another caller's run covered this one, and `ok` reports how THAT run
/// went, so a caller never has to ask twice.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnceOutcome {
    /// Whether this call performed the run itself.
    pub ran: bool,
    /// Whether the run — this one or the one joined — exited 0.
    pub ok: bool,
    /// The tail of what it said, when it did not exit 0. Empty otherwise:
    /// a successful run's chatter is nobody's business.
    pub said: String,
}

/// Most of what a failing CLI says is a stack trace; the last lines name
/// the error, so only the tail is worth carrying back to a message.
const TAIL_BYTES: usize = 2000;

/// The single-flight owner. Tauri managed state, cloned into blocking tasks
/// the same way [`crate::worktree::RepoLocks`] is.
///
/// Poison recovers rather than propagates: a panicked run leaves nothing
/// this module owns in an unknown state — the child is the caller's
/// business and the counter below is monotonic — so blocking every later
/// run for the life of the app would cost more than it protects.
#[derive(Clone)]
pub struct OnceRunner {
    locks: KeyedLocks<String>,
    /// What each key's last completed run left behind. Read WITHOUT the key
    /// lock and again once it is held: a change in [`Finished::count`]
    /// across that gap is the proof that somebody else's run covered this
    /// caller, and it is why no "already done" memory is needed.
    ///
    /// The first read must NOT take the key lock. Reading it under the lock
    /// would block until the very run we are trying to detect had finished,
    /// and the comparison would then see nothing — a caller would join
    /// nobody and start a second child. (Tried; the join test caught it.)
    ///
    /// One entry per key, never evicted — the same growth the lock map
    /// beside it has by design. Keys here are config dirs, so the
    /// population is the workspaces a person opens, not user input.
    completed: std::sync::Arc<Mutex<HashMap<String, Finished>>>,
}

/// The trace one key's completed runs leave for a caller that waited.
#[derive(Clone)]
struct Finished {
    /// How many runs have completed for this key. Monotonic, so a waiter
    /// comparing it across its wait cannot be fooled into believing nothing
    /// happened.
    count: u64,
    ok: bool,
    said: String,
}

impl Default for OnceRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl OnceRunner {
    pub fn new() -> Self {
        Self {
            locks: KeyedLocks::new(PoisonPolicy::Recover),
            completed: Default::default(),
        }
    }

    fn seen(&self, key: &str) -> Option<Finished> {
        self.completed
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(key)
            .cloned()
    }

    /// Run `command` with `args` and `env` on top of the augmented spawn
    /// PATH, at most one run per `key` at a time.
    ///
    /// A caller that arrives while another run holds the key waits for it
    /// and takes its result (`ran: false`). A caller that arrives when no
    /// run is in flight performs one (`ran: true`) — it has just judged the
    /// work necessary, and this module has no standing to disagree.
    pub fn run(
        &self,
        key: &str,
        program: &std::path::Path,
        args: &[String],
        env: &[(String, String)],
        budget: Duration,
        poll: Duration,
    ) -> OnceOutcome {
        let before = self.seen(key).map(|last| last.count).unwrap_or(0);
        let lock = self.locks.for_key(key.to_string());
        let _held = self.locks.acquire(&lock);
        // Somebody finished a run for this key while we waited: theirs
        // covers ours, and its result is the honest answer to give back.
        if let Some(last) = self.seen(key).filter(|last| last.count > before) {
            return OnceOutcome { ran: false, ok: last.ok, said: last.said };
        }
        let mut command = Command::new(program);
        command.args(args).env("PATH", keepdeck_env::augmented_path());
        for (name, value) in env {
            command.env(name, value);
        }
        let (ok, said) = match crate::run_bounded::run_bounded(
            &mut command,
            budget,
            poll,
            16 * 1024,
        ) {
            // Told apart on purpose: a refusal is instant and names a bad
            // request, while a timeout means it ran and would not stop.
            // Reporting the first as the second sends a reader hunting a
            // hang that never happened.
            Err(crate::run_bounded::RunFailure::Refused(why)) => {
                (false, format!("could not start: {why}"))
            }
            Err(crate::run_bounded::RunFailure::TimedOut) => (
                false,
                format!("did not finish within {}s and was killed", budget.as_secs()),
            ),
            Ok(output) if output.success => (true, String::new()),
            Ok(output) => {
                let from = output.said.len().saturating_sub(TAIL_BYTES);
                (false, String::from_utf8_lossy(&output.said[from..]).into_owned())
            }
        };
        let mut done = self.completed.lock().unwrap_or_else(|p| p.into_inner());
        let entry = done.entry(key.to_string()).or_insert(Finished {
            count: 0,
            ok,
            said: String::new(),
        });
        entry.count += 1;
        entry.ok = ok;
        entry.said = said.clone();
        OnceOutcome { ran: true, ok, said }
    }
}

/// Loader variables a caller may never set. HYGIENE, NOT A BARRIER —
/// read the limits below before relying on this.
///
/// These turn "run this program" into "run my code inside this program":
/// the dynamic loader reads them before the program's own first
/// instruction. Refusing them costs nothing and removes the laziest
/// escalation, so they are refused.
///
/// WHAT THIS DOES NOT DO, so nobody reads more into it than it says:
/// - The interpreter families are NOT here. `NODE_OPTIONS=--require x.js`
///   does exactly what `DYLD_INSERT_LIBRARIES` does, and so do the Python,
///   Ruby, Perl, Java and shell equivalents. Enumerating them was weighed
///   and declined: the list ages, and every candidate rule that closed it
///   (declaring names in a manifest, deriving a prefix from the plugin's
///   id) could be defeated by the plugin author, who writes both.
/// - Nothing here bounds ARGUMENTS, and for an agent CLI the arguments are
///   the whole story: `<cli> -p "<anything>"` is arbitrary action.
/// - Nothing here bounds a CLI's own config loading. `OPENCODE_CONFIG_CONTENT`
///   names plugin files to load, and the host itself relies on it, so it
///   cannot be refused.
///
/// The trust boundary is therefore INSTALLATION, not this function: a
/// plugin the user installed may run what its `exec` capability names, and
/// for a CLI that loads its own config and extensions that is close to
/// "may run code". Said plainly so a later reader does not mistake this
/// list for a wall.
///
/// Prefix-matched, because the loader families are open-ended (`DYLD_` on
/// macOS, `LD_` on Linux).
const LOADER_PREFIXES: [&str; 2] = ["DYLD_", "LD_"];

/// `PATH` is refused separately: the run resolves its program on the
/// augmented spawn PATH on purpose, and letting a caller replace it would
/// re-point every lookup the child makes afterwards.
fn refuse_env(name: &str) -> Option<String> {
    if name.is_empty() {
        return Some("an env name that is empty".into());
    }
    // A NUL cannot be carried across execve; `Command::env` panics on one,
    // and a string a plugin chose must never panic a host thread.
    if name.contains('\0') {
        return Some(format!("{name:?} carries a NUL"));
    }
    let upper = name.to_ascii_uppercase();
    if upper == "PATH" {
        return Some("PATH is the host's to set".into());
    }
    if LOADER_PREFIXES.iter().any(|p| upper.starts_with(p)) {
        return Some(format!(
            "{name} would load code into the program before it runs"
        ));
    }
    None
}

/// Both halves of one pair, because `Command::env` panics on a NUL in
/// EITHER — and the string on both sides came from a caller. Checking only
/// the name left the promise above half-kept: reviewed, and true.
fn refuse_pair(name: &str, value: &str) -> Option<String> {
    if value.contains('\0') {
        return Some(format!("the value of {name} carries a NUL"));
    }
    refuse_env(name)
}

/// A command is a NAME resolved on the spawn PATH, never a path.
///
/// Anything with a separator would let a caller point at a binary of its
/// own choosing while naming something innocuous — the capability it
/// declared would then bound nothing at all.
fn refuse_command(command: &str) -> Option<String> {
    if command.is_empty() {
        return Some("an empty command".into());
    }
    if command.contains('/') || command.contains('\\') {
        return Some(format!("{command} is a path, not a command name"));
    }
    None
}

/// How long one handed-over run may take, and how often its exit is polled.
/// Generous on purpose: the host cannot know what the caller asked for, and
/// a kill here should mean "hung", never "slower than we guessed".
const RUN_BUDGET: Duration = Duration::from_secs(120);
const RUN_POLL: Duration = Duration::from_millis(250);

/// Perform work a plugin handed over: run `command` once per `key` at a
/// time, and answer how it went.
///
/// The host supplies the MECHANISM only — resolving the command on the
/// spawn PATH, bounding the run, and single-flighting by key. What to run,
/// with which arguments and environment, and whether it is needed at all,
/// are the caller's: they are the part that knows a particular CLI, and
/// that knowledge has no business here.
///
/// Authorisation happens where every plugin call is authorised, on the
/// declared `exec` capability — the same one that already gates spawning a
/// session with this command. This adds no power: a plugin that may run a
/// command in a terminal may run it without one.
#[tauri::command(async)]
pub async fn exec_run_once(
    runner: tauri::State<'_, OnceRunner>,
    key: String,
    command: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
) -> Result<OnceOutcome, String> {
    if let Some(why) = refuse_command(&command) {
        return Err(format!("refused: {why}"));
    }
    if let Some(why) = env.iter().find_map(|(name, value)| refuse_pair(name, value)) {
        return Err(format!("refused: {why}"));
    }
    let program = keepdeck_env::find_program(&command, keepdeck_env::augmented_path())
        .ok_or_else(|| format!("{command} not found on PATH"))?;
    // The wait is measured in tens of seconds: it belongs on the blocking
    // pool, never on an async worker, and the runner is cloned out of the
    // State because a State cannot cross into a blocking task.
    let runner = runner.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        runner.run(&key, &program, &args, &env, RUN_BUDGET, RUN_POLL)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn sh() -> std::path::PathBuf {
        std::path::PathBuf::from("/bin/sh")
    }

    fn args(script: &str) -> Vec<String> {
        vec!["-c".into(), script.into()]
    }

    const BUDGET: Duration = Duration::from_secs(20);
    const POLL: Duration = Duration::from_millis(10);

    #[test]
    fn a_run_reports_what_it_did() {
        let runner = OnceRunner::new();
        let out = runner.run("k", &sh(), &args("exit 0"), &[], BUDGET, POLL);
        assert!(out.ran, "the only caller must have run it");
        assert!(out.ok);
        assert_eq!(out.said, "", "a successful run says nothing back");
    }

    #[test]
    fn a_failing_run_carries_its_tail_back() {
        let runner = OnceRunner::new();
        let out = runner.run("k", &sh(), &args("echo nope >&2; exit 3"), &[], BUDGET, POLL);
        assert!(out.ran);
        assert!(!out.ok);
        assert!(out.said.contains("nope"), "tail lost: {:?}", out.said);
    }

    #[test]
    fn env_reaches_the_child() {
        let runner = OnceRunner::new();
        let env = vec![("KD_PROBE".to_string(), "here".to_string())];
        let out = runner.run(
            "k",
            &sh(),
            &args(r#"[ "$KD_PROBE" = here ] || exit 7"#),
            &env,
            BUDGET,
            POLL,
        );
        assert!(out.ok, "env did not reach the child: {:?}", out.said);
    }

    #[test]
    fn a_caller_arriving_mid_run_joins_it_instead_of_starting_a_second() {
        // The whole point of the module: two panes of one workspace ask at
        // the same moment, and exactly ONE child runs.
        let runner = OnceRunner::new();
        let dir = tempfile::tempdir().expect("dir");
        let marks = dir.path().join("marks");
        let script = format!(
            "echo x >> {}; sleep 1",
            marks.display()
        );
        let started = Arc::new(AtomicUsize::new(0));
        let mut hands = Vec::new();
        for _ in 0..3 {
            let runner = runner.clone();
            let script = script.clone();
            let started = started.clone();
            hands.push(std::thread::spawn(move || {
                started.fetch_add(1, Ordering::SeqCst);
                runner.run("same", &sh(), &args(&script), &[], BUDGET, POLL)
            }));
        }
        let outcomes: Vec<OnceOutcome> = hands.into_iter().map(|h| h.join().expect("thread")).collect();
        assert_eq!(started.load(Ordering::SeqCst), 3, "all three asked");
        let ran = outcomes.iter().filter(|o| o.ran).count();
        assert_eq!(ran, 1, "exactly one caller may run the child");
        assert!(outcomes.iter().all(|o| o.ok), "joiners must learn the result");
        let written = std::fs::read_to_string(&marks).unwrap_or_default();
        assert_eq!(
            written.lines().count(),
            1,
            "a second child ran: {written:?}",
        );
    }

    #[test]
    fn a_caller_arriving_after_a_run_finished_runs_again() {
        // Single-flight, not run-once-ever: the caller re-judged the world
        // before asking, and this module has no standing to refuse it.
        let runner = OnceRunner::new();
        let first = runner.run("k", &sh(), &args("exit 0"), &[], BUDGET, POLL);
        let second = runner.run("k", &sh(), &args("exit 0"), &[], BUDGET, POLL);
        assert!(first.ran && second.ran, "a finished run must not block a later one");
    }

    #[test]
    fn a_command_must_be_a_name_never_a_path() {
        // Naming a path would let a caller point at a binary of its own
        // while the capability it declared bounds something else entirely.
        assert!(refuse_command("opencode").is_none());
        assert!(refuse_command("/usr/bin/env").is_some());
        assert!(refuse_command("../../evil").is_some());
        assert!(refuse_command("dir\\evil").is_some());
        assert!(refuse_command("").is_some());
    }

    #[test]
    fn loader_variables_are_refused_whatever_the_command_is() {
        // The escalation this closes: a plugin cleared to run one program
        // running its OWN code under that program's name.
        assert!(refuse_env("OPENCODE_CONFIG_DIR").is_none());
        assert!(refuse_env("HOME").is_none());
        assert!(refuse_env("DYLD_INSERT_LIBRARIES").is_some());
        assert!(refuse_env("LD_PRELOAD").is_some());
        assert!(refuse_env("ld_preload").is_some(), "case must not be a bypass");
        assert!(refuse_env("PATH").is_some(), "the spawn PATH is the host's");
        assert!(refuse_env("path").is_some());
    }

    #[test]
    fn a_degenerate_env_name_is_refused_before_it_can_panic_a_host_thread() {
        // `Command::env` panics on a NUL, and the string came from a plugin:
        // a caller's bad input must never take a host thread down with it.
        assert!(refuse_env("").is_some());
        assert!(refuse_env("OK_NAME\0evil").is_some());
        // BOTH halves: `Command::env` panics on either, and the first cut of
        // this guard checked only the name — which kept the promise above
        // exactly half of the time.
        assert!(refuse_pair("FINE", "also fine").is_none());
        assert!(refuse_pair("FINE", "value\0evil").is_some());
    }

    #[test]
    fn different_keys_do_not_wait_for_each_other() {
        let runner = OnceRunner::new();
        let a = runner.run("a", &sh(), &args("exit 0"), &[], BUDGET, POLL);
        let b = runner.run("b", &sh(), &args("exit 0"), &[], BUDGET, POLL);
        assert!(a.ran && b.ran);
    }
}
