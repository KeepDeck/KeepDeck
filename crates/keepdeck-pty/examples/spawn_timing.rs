//! Measures session spawn latency and time-to-first-output, to tell apart a
//! slow `PtySession::spawn` from slow shell initialization.
//!
//! Run: `cargo run -q --example spawn_timing [N]` (default N = 1). Uses $SHELL.

use std::time::{Duration, Instant};

use keepdeck_pty::{PtyEvent, PtySession, PtySpec, TermSize};

fn main() {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let n: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);
    println!("shell = {shell}, sessions = {n}\n");

    let all = Instant::now();
    let mut sessions = Vec::new();
    for i in 0..n {
        let t = Instant::now();
        let (session, rx) =
            PtySession::spawn(PtySpec::command(&shell, TermSize::default())).expect("spawn");
        println!("spawn #{i:>2}: {:?}", t.elapsed());
        sessions.push((session, rx, Instant::now()));
    }
    println!("\nall {n} spawn() calls: {:?}\n", all.elapsed());

    for (i, (_session, rx, since)) in sessions.iter().enumerate() {
        match rx.recv_timeout(Duration::from_secs(15)) {
            Ok(PtyEvent::Output(bytes)) => {
                println!("#{i:>2} first output: {:?} ({} bytes)", since.elapsed(), bytes.len());
            }
            Ok(PtyEvent::Exited(_)) => println!("#{i:>2} exited before output"),
            Err(_) => println!("#{i:>2} NO output within 15s"),
        }
    }
}
