//! The reader thread must never be the thing that stops a child.
//!
//! A PTY master that stops being read fills its kernel buffer within about a
//! kilobyte, and the child blocks mid-write — alive, silent, and looking
//! exactly like a hang. So anything that can pause the reader can freeze a
//! working agent, and these tests spawn real processes to prove it cannot.

#![cfg(unix)]

use std::thread;
use std::time::{Duration, Instant};

use keepdeck_pty::{
    parse_drop_marker, Consumer, PtyEvent, PtySession, PtySpec, TermSize, OUTPUT_CAP_BYTES,
};

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

/// Wait for the child to be reaped, or give up at `deadline`.
fn reaped_within(session: &PtySession, deadline: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < deadline {
        if session.has_exited() {
            return true;
        }
        thread::sleep(Duration::from_millis(20));
    }
    false
}

/// A script writing `bytes` of output — comfortably past the queue's cap, so
/// the child cannot possibly finish while anything downstream is buffering it.
fn flooder(bytes: usize) -> String {
    format!("head -c {bytes} /dev/zero | tr '\\0' 'x'")
}

#[test]
fn a_flooding_child_finishes_while_nobody_drains() {
    let (session, consumer) = spawn_sh(&flooder(OUTPUT_CAP_BYTES * 2));
    // `consumer` is held and never read — that is the whole scenario. Held,
    // because dropping it would stop the child for an unrelated reason.

    assert!(
        reaped_within(&session, Duration::from_secs(30)),
        "the child never finished: the reader stalled and the PTY stopped being drained"
    );

    // The bytes that had to go are accounted for rather than silently missing.
    let mut announced = 0;
    while let Some(event) = consumer.recv_timeout(Duration::from_millis(200)) {
        match event {
            PtyEvent::Output(bytes) => announced += parse_drop_marker(&bytes).unwrap_or(0),
            PtyEvent::Exited(_) => break,
        }
    }
    assert!(
        announced > 0,
        "output was dropped to stay under the cap, so the gap must be announced"
    );
}

#[test]
fn a_dropped_consumer_stops_a_child_with_a_backlog() {
    let (session, consumer) = spawn_sh(&flooder(OUTPUT_CAP_BYTES * 2));
    // Take one event so the session is unmistakably running, then walk away
    // mid-flood: megabytes are still queued and the child is still writing.
    assert!(
        consumer.recv_timeout(Duration::from_secs(10)).is_some(),
        "expected the flood to start"
    );
    drop(consumer);

    assert!(
        reaped_within(&session, Duration::from_secs(30)),
        "a child nobody is listening to must be stopped and reaped, backlog or not"
    );
}
