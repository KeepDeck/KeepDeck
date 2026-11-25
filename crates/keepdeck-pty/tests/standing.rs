//! How processes stand to a pane's terminal — the fact the bridge and the
//! MCP socket ask of the kernel before a rule lets a sender speak for a pane.
//! Real PTYs and real processes: the answer is the kernel's, so a fake would
//! only test the fake.

#![cfg(unix)]

use std::time::{Duration, Instant};

use keepdeck_pty::sessions::Standing;
use keepdeck_pty::{Consumer, PtyEvent, PtySession, PtySpec, TermSize};

/// Accumulate output until every `NAME=<pid>` in `names` has appeared.
fn read_pids(events: &Consumer, names: &[&str]) -> Vec<u32> {
    let started = Instant::now();
    let mut seen = String::new();
    while started.elapsed() < Duration::from_secs(5) {
        let pids: Option<Vec<u32>> = names.iter().map(|name| pid_after(&seen, name)).collect();
        if let Some(pids) = pids {
            return pids;
        }
        match events.recv_timeout(Duration::from_millis(200)) {
            Some(PtyEvent::Output(bytes)) => seen.push_str(&String::from_utf8_lossy(&bytes)),
            Some(PtyEvent::Exited(info)) => panic!("exited ({info:?}); output: {seen}"),
            None => {}
        }
    }
    panic!("timed out waiting for {names:?}; output so far: {seen}");
}

/// The `<name>=<n>` a line of `output` begins with, once that line has ended:
/// a pid split across two reads is not a pid yet. Matched at a line's start,
/// because one name can end another — `WHOOK=` holds `HOOK=` — and the
/// processes print in whichever order they happen to run.
fn pid_after(output: &str, name: &str) -> Option<u32> {
    let prefix = format!("{name}=");
    let ended = &output[..output.rfind('\n').map_or(0, |end| end + 1)];
    ended
        .lines()
        .find_map(|line| line.trim_end_matches('\r').strip_prefix(prefix.as_str())?.parse().ok())
}

#[test]
fn a_pid_is_read_by_its_own_name_from_a_whole_line() {
    assert_eq!(pid_after("WHOOK=9\r\nHOOK=5\r\n", "HOOK"), Some(5));
    assert_eq!(pid_after("HOOK=5", "HOOK"), None, "a line not ended yet");
    assert_eq!(pid_after("WHOOK=9\r\n", "HOOK"), None);
}

fn spawn_sh(script: &str) -> (PtySession, Consumer) {
    PtySession::spawn(PtySpec {
        command: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        env: Vec::new(),
        env_defaults: Vec::new(),
        cwd: None,
        size: TermSize::default(),
    })
    .expect("spawn sh")
}

fn kill(pid: u32) {
    // SAFETY: a process this test started.
    unsafe { libc::kill(pid as i32, libc::SIGKILL) };
}

#[test]
fn a_process_stands_in_the_terminal_as_its_child_or_in_a_session_started_from_it_and_no_further() {
    // The terminal's shell plays the agent.
    // - A backgrounded child stays in its session: a tool call.
    // - HOOKSH leaves with setsid(2), as an agent starts the shell of a hook
    //   — and as kimi starts its MCP servers, opencode 2.x its `serve`. Its
    //   parent runs in the terminal, and it leads a session of its own.
    // - HOOK is that shell's child, in that session: curl posting a report.
    // - DAEMON leaves the same way and forks WORKER, which stays in its
    //   session and later starts a hook of its own: WHOOKSH leaves with
    //   setsid(2), and WHOOK is its child.
    let (session, events) = spawn_sh(
        "echo SELF=$$; sleep 30 & echo CHILD=$!; \
         perl -e 'use POSIX; setsid(); print \"HOOKSH=$$\\n\"; \
           if (fork()) { sleep 30; exit } print \"HOOK=$$\\n\"; sleep 30' & \
         perl -e 'use POSIX; setsid(); print \"DAEMON=$$\\n\"; \
           if (fork()) { sleep 30; exit } print \"WORKER=$$\\n\"; \
           if (fork()) { sleep 30; exit } setsid(); print \"WHOOKSH=$$\\n\"; \
           if (fork()) { sleep 30; exit } print \"WHOOK=$$\\n\"; sleep 30' & wait",
    );
    let names = ["SELF", "CHILD", "HOOKSH", "HOOK", "DAEMON", "WORKER", "WHOOKSH", "WHOOK"];
    let pids = read_pids(&events, &names);
    let [own, child, hook_sh, hook, daemon, worker, worker_hook_sh, worker_hook] = pids[..] else {
        unreachable!("one pid per name")
    };

    assert_eq!(session.standing(own), Some(Standing::InTerminal), "the terminal's own leader");
    assert_eq!(session.standing(child), Some(Standing::InTerminal), "a child that stayed");
    // It fits a session started from here too; the strictest standing wins,
    // or the MCP door would refuse kimi's servers and opencode's `serve`.
    assert_eq!(session.standing(hook_sh), Some(Standing::ChildOfTerminal), "a detached child");
    assert_eq!(session.standing(daemon), Some(Standing::ChildOfTerminal), "a daemon started from here");
    assert_eq!(session.standing(hook), Some(Standing::SessionFromTerminal), "a hook");
    // The daemon's worker stands where a hook does — one session out — so a
    // rule cannot tell the two apart by where they stand.
    assert_eq!(session.standing(worker), Some(Standing::SessionFromTerminal), "a daemon's worker");
    // Nothing chains further: the worker's hook started from outside.
    assert_eq!(session.standing(worker_hook_sh), None, "the shell of a worker's hook");
    assert_eq!(session.standing(worker_hook), None, "a worker's hook");
    assert_eq!(session.standing(u32::MAX), None, "no such process");
    assert_eq!(session.standing(0), None, "pid 0 names no process");

    // Another terminal's processes are not this one's.
    let (other, other_events) = spawn_sh("echo SELF=$$; sleep 30");
    let stranger = read_pids(&other_events, &["SELF"])[0];
    assert_eq!(session.standing(stranger), None);
    assert_eq!(other.standing(stranger), Some(Standing::InTerminal));

    // The detached ones are in no pane's group; take them down by hand.
    for pid in [worker_hook, worker_hook_sh, worker, daemon, hook, hook_sh] {
        kill(pid);
    }
    session.force_stop();
    other.force_stop();
}

#[test]
fn a_detached_process_whose_starter_is_gone_stands_nowhere() {
    // A daemon outlives the agent that started it and is handed to init;
    // from then on nothing ties it or its session to the terminal it came
    // from.
    let (session, events) = spawn_sh(
        "sh -c 'perl -e \"use POSIX; setsid(); print qq(DETACHED=\\$\\$\\n); \
           if (fork()) { sleep 30; exit } print qq(WORKER=\\$\\$\\n); sleep 30\" &'; \
         echo READY=0; sleep 30",
    );
    let pids = read_pids(&events, &["DETACHED", "WORKER", "READY"]);
    let (detached, worker) = (pids[0], pids[1]);
    // The intermediate sh has exited; wait until the daemon is reparented.
    let started = Instant::now();
    while session.standing(detached).is_some() && started.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(session.standing(detached), None);
    assert_eq!(session.standing(worker), None, "nor does a session it leads");
    kill(worker);
    kill(detached);
    session.force_stop();
}

#[test]
fn nothing_stands_in_a_terminal_whose_child_is_gone() {
    // Once the leader is reaped its id may be handed to a stranger, so the
    // answer must stop being yes even for a process still holding that sid.
    let (session, events) = spawn_sh("echo SELF=$$; exit 0");
    let own = read_pids(&events, &["SELF"])[0];
    let started = Instant::now();
    while !session.has_exited() && started.elapsed() < Duration::from_secs(5) {
        let _ = events.recv_timeout(Duration::from_millis(100));
    }
    assert!(session.has_exited());
    assert_eq!(session.standing(own), None);
}
