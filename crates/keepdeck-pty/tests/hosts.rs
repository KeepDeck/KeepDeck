//! Which processes belong to a pane's terminal — the question the bridge and
//! the MCP socket ask before letting a sender speak for a pane. Real PTYs and
//! real processes: the answer is the kernel's, so a fake would only test the
//! fake.

#![cfg(unix)]

use std::time::{Duration, Instant};

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

fn pid_after(output: &str, name: &str) -> Option<u32> {
    let rest = output.split(&format!("{name}=")).nth(1)?;
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    // A pid split across two reads is not a pid yet.
    rest[digits.len()..].starts_with(['\r', '\n']).then(|| digits.parse().ok())?
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
fn the_terminal_hosts_its_own_and_their_detached_children_but_not_a_daemons_workers() {
    // A backgrounded child stays in the terminal's session: a hook, a tool
    // call. The perl one leaves with setsid(2), as kimi starts its MCP
    // servers: detached, but its parent is the shell in this terminal. It
    // then forks a child of its own, the shape of a daemon's worker: its
    // parent is the detached process, outside.
    let (session, events) = spawn_sh(
        "echo SELF=$$; sleep 30 & echo CHILD=$!; \
         perl -e 'use POSIX; setsid(); print \"DETACHED=$$\\n\"; \
           if (my $k = fork()) { sleep 30 } else { print \"WORKER=$$\\n\"; sleep 30 }' & wait",
    );
    let pids = read_pids(&events, &["SELF", "CHILD", "DETACHED", "WORKER"]);
    let (own, child, detached, worker) = (pids[0], pids[1], pids[2], pids[3]);

    assert!(session.hosts(own, None), "the terminal's own leader");
    assert!(session.hosts(child, None), "a child that stayed");
    assert!(session.hosts(detached, None), "a detached child of a process in the terminal");
    assert!(!session.hosts(worker, None), "a child of a detached process");
    assert!(!session.hosts(u32::MAX, None), "no such process");
    assert!(!session.hosts(0, None), "pid 0 names no process");

    // Another terminal's processes are not this one's.
    let (other, other_events) = spawn_sh("echo SELF=$$; sleep 30");
    let stranger = read_pids(&other_events, &["SELF"])[0];
    assert!(!session.hosts(stranger, None));
    assert!(other.hosts(stranger, None));

    // The detached pair is in no pane's tree; take it down by hand.
    kill(worker);
    kill(detached);
    session.force_stop();
    other.force_stop();
}

#[test]
fn a_detached_process_whose_starter_is_gone_belongs_to_nobody() {
    // A daemon outlives the agent that started it and is handed to init;
    // from then on nothing ties it to the terminal it came from.
    let (session, events) = spawn_sh(
        "sh -c 'perl -e \"use POSIX; setsid(); print qq(DETACHED=\\$\\$\\n); sleep 30\" &'; \
         echo READY=0; sleep 30",
    );
    let detached = read_pids(&events, &["DETACHED", "READY"])[0];
    // The intermediate sh has exited; wait until the daemon is reparented.
    let started = Instant::now();
    while session.hosts(detached, None) && started.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!session.hosts(detached, None));
    kill(detached);
    session.force_stop();
}

#[test]
fn nothing_belongs_to_a_terminal_whose_child_is_gone() {
    // Once the leader is reaped its id may be handed to a stranger, so the
    // answer must stop being yes even for a process still holding that sid.
    let (session, events) = spawn_sh("echo SELF=$$; exit 0");
    let own = read_pids(&events, &["SELF"])[0];
    let started = Instant::now();
    while !session.has_exited() && started.elapsed() < Duration::from_secs(5) {
        let _ = events.recv_timeout(Duration::from_millis(100));
    }
    assert!(session.has_exited());
    assert!(!session.hosts(own, None));
}

#[test]
fn the_process_a_pane_vouches_for_brings_in_its_children_and_no_further() {
    // opencode 2.x: the agent runs in a `serve` it starts detached, and serve
    // starts the MCP servers. Here: a detached process (the vouched agent),
    // its child (an MCP server) and that child's child.
    let (session, events) = spawn_sh(
        "echo SELF=$$; \
         perl -e 'use POSIX; setsid(); print \"AGENT=$$\\n\"; \
           if (my $k = fork()) { sleep 30 } else { print \"SERVER=$$\\n\"; \
             if (my $g = fork()) { sleep 30 } else { print \"GRANDCHILD=$$\\n\"; sleep 30 } }' & wait",
    );
    let pids = read_pids(&events, &["SELF", "AGENT", "SERVER", "GRANDCHILD"]);
    let (own, agent, server, grandchild) = (pids[0], pids[1], pids[2], pids[3]);

    // Unvouched, the agent's child is outside: its parent left the terminal.
    assert!(!session.hosts(server, None));
    // Vouched, the agent's own children are the pane's...
    assert!(session.hosts(server, Some(agent)), "a child of the vouched agent");
    assert!(session.hosts(agent, Some(agent)), "the vouched agent itself");
    // ...and nothing further: being admitted through a parent is not a
    // licence for one's own children, or a daemon's workers would follow.
    assert!(!session.hosts(grandchild, Some(agent)), "a grandchild of the vouched agent");

    // A pin naming a process that is not this terminal's counts for nothing.
    let (other, other_events) = spawn_sh("echo SELF=$$; sleep 30");
    let stranger = read_pids(&other_events, &["SELF"])[0];
    assert!(!session.hosts(stranger, Some(stranger)));
    assert!(session.hosts(own, Some(stranger)), "the terminal's own still are");

    kill(grandchild);
    kill(server);
    kill(agent);
    session.force_stop();
    other.force_stop();
}
