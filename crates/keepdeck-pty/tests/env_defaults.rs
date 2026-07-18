//! `env_defaults` semantics in ISOLATION: `std::env::set_var` mutates the
//! process-global environ, which races `posix_spawn`/`env::vars()` in other
//! threads — so this lives in its own test binary (own process, one test)
//! instead of the parallel pty_session suite.

use std::time::Duration;

use keepdeck_pty::{PtyEvent, PtySession, PtySpec, TermSize};

#[test]
fn env_defaults_yield_to_the_inherited_environment() {
    // A key the environment already carries must survive a default; a key
    // it lacks must receive one.
    std::env::set_var("KD_PTY_TEST_PRESET", "user-value");
    let mut spec = PtySpec {
        command: "/bin/sh".to_string(),
        args: vec![
            "-c".to_string(),
            "echo ${KD_PTY_TEST_PRESET}:${KD_PTY_TEST_FRESH}".to_string(),
        ],
        env: Vec::new(),
        env_defaults: vec![
            ("KD_PTY_TEST_PRESET".into(), "default-loses".into()),
            ("KD_PTY_TEST_FRESH".into(), "default-wins".into()),
        ],
        cwd: None,
        size: TermSize::default(),
    };
    spec.env.push(("KD_PTY_TEST_NOISE".into(), "x".into()));
    let (_session, rx) = PtySession::spawn(spec).expect("spawn sh");
    let mut out = Vec::new();
    while let Ok(event) = rx.recv_timeout(Duration::from_secs(5)) {
        match event {
            PtyEvent::Output(bytes) => out.extend_from_slice(&bytes),
            PtyEvent::Exited(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&out);
    assert!(text.contains("user-value:default-wins"), "got: {text}");
}
