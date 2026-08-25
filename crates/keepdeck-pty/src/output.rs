//! The transport between a session's reader thread and whoever delivers its
//! output onward.
//!
//! The reader thread must NEVER wait here. A PTY master that stops being read
//! fills its kernel buffer within a kilobyte or so, and the child then blocks
//! mid-write — alive, silent, and indistinguishable from a hang. Backpressure
//! applied to the reader therefore reaches all the way into the child process,
//! which is why this queue bounds memory by dropping instead of by blocking.
//!
//! Three properties have to hold at once, and no channel in the standard
//! library (or already in this workspace) offers all three: the producer never
//! waits, memory is bounded, and content stays intact up to the cap. A bounded
//! `sync_channel` buys the second at the cost of the first; an unbounded one
//! the reverse; a bounded try-send drops silently. So: pending chunks coalesce,
//! the oldest go first once the cap is reached, and the gap they leave is
//! announced in the stream itself.

use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::{ExitInfo, PtyEvent};

/// How much undelivered output one session may hold before its oldest bytes
/// are dropped.
///
/// Sized from measurement, not caution: an agent's terminal UI repaints rather
/// than streams, and its busiest observed second moved 3.8 KiB. Four mebibytes
/// is therefore something like eighteen minutes of a delivery side that has
/// stopped consuming entirely, and roughly two hundred times the largest
/// startup burst any agent was measured to produce.
///
/// Unrelated to the view's replay budget in `ptyManager.ts`. That one bounds
/// how much history a remounting terminal can repaint; this one bounds output
/// that has not been shown at all. The two never meet at realistic volumes —
/// a full minute of stalled delivery is around 230 KiB — so tying them
/// together would invent a relationship that does not exist.
pub const OUTPUT_CAP_BYTES: usize = 4 * 1024 * 1024;

/// The largest chunk coalescing will build. Merging pending reads keeps the
/// queue's per-chunk overhead down, but an unbounded merge would hand the
/// delivery side one enormous message after a stall; this keeps deliveries a
/// size a webview can swallow.
const COALESCE_MAX_BYTES: usize = 64 * 1024;

/// The gap marker's exact wire form, in two halves around the byte count:
/// `\r\n[keepdeck] dropped <n> bytes of output\r\n`.
///
/// It is plain text on purpose — it is meant to be read in the terminal where
/// the gap happened, so it must survive being written straight to a screen.
/// It always travels as a chunk of its own, and [`parse_drop_marker`] matches
/// whole chunks only, so ordinary output that happens to contain this wording
/// is not mistaken for it.
const MARKER_HEAD: &[u8] = b"\r\n[keepdeck] dropped ";
const MARKER_TAIL: &[u8] = b" bytes of output\r\n";

/// What became of a pushed event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushOutcome {
    /// Queued — possibly merged into the chunk ahead of it, possibly at the
    /// cost of the oldest bytes if that put the queue over its cap. Either
    /// way the producer's job is done and unchanged; a gap, if there was one,
    /// travels to the consumer as a marker in the stream rather than as an
    /// answer here, so there is one channel for it instead of two.
    Enqueued,
    /// Nobody is listening any more. The caller owns the child, so it is the
    /// caller's job to stop it.
    ConsumerGone,
}

/// Build the marker announcing `bytes` lost.
fn drop_marker(bytes: usize) -> Vec<u8> {
    let mut marker = Vec::with_capacity(MARKER_HEAD.len() + MARKER_TAIL.len() + 8);
    marker.extend_from_slice(MARKER_HEAD);
    marker.extend_from_slice(bytes.to_string().as_bytes());
    marker.extend_from_slice(MARKER_TAIL);
    marker
}

/// Read a gap marker's byte count, if `chunk` is one.
///
/// Whole-chunk match by design: the queue emits a marker alone, so anything
/// with output around it is output, not a marker.
pub fn parse_drop_marker(chunk: &[u8]) -> Option<usize> {
    let digits = chunk
        .strip_prefix(MARKER_HEAD)?
        .strip_suffix(MARKER_TAIL)?;
    if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    std::str::from_utf8(digits).ok()?.parse().ok()
}

#[derive(Default)]
struct State {
    cap: usize,
    chunks: VecDeque<Vec<u8>>,
    queued: usize,
    /// Bytes dropped since the consumer last took a marker. One marker per
    /// run of drops, naming the whole gap.
    dropped: usize,
    exited: Option<ExitInfo>,
    producer_gone: bool,
    consumer_gone: bool,
}

struct Shared {
    state: Mutex<State>,
    ready: Condvar,
}

/// A session's output queue, before it is split into its two ends.
pub struct OutputQueue {
    shared: Arc<Shared>,
}

impl OutputQueue {
    /// A queue holding at most `cap_bytes` of undelivered output.
    pub fn new(cap_bytes: usize) -> Self {
        Self {
            shared: Arc::new(Shared {
                state: Mutex::new(State {
                    cap: cap_bytes,
                    ..State::default()
                }),
                ready: Condvar::new(),
            }),
        }
    }

    /// Hand out the writing and reading ends.
    pub fn split(self) -> (Producer, Consumer) {
        (
            Producer {
                shared: self.shared.clone(),
            },
            Consumer {
                shared: self.shared,
            },
        )
    }
}

/// The writing end. Held by the thread reading the PTY master.
pub struct Producer {
    shared: Arc<Shared>,
}

impl Producer {
    /// Queue `event`. Never waits.
    pub fn push(&self, event: PtyEvent) -> PushOutcome {
        let mut state = self.shared.state.lock().expect("output queue poisoned");
        if state.consumer_gone {
            return PushOutcome::ConsumerGone;
        }
        let outcome = match event {
            PtyEvent::Output(bytes) => {
                state.append(bytes);
                state.evict_to_cap();
                PushOutcome::Enqueued
            }
            PtyEvent::Exited(info) => {
                state.exited = Some(info);
                PushOutcome::Enqueued
            }
        };
        drop(state);
        self.shared.ready.notify_all();
        outcome
    }
}

impl Drop for Producer {
    fn drop(&mut self) {
        self.shared
            .state
            .lock()
            .expect("output queue poisoned")
            .producer_gone = true;
        self.shared.ready.notify_all();
    }
}

/// The reading end. Held by whoever delivers output onward — the only side
/// that is allowed to wait.
pub struct Consumer {
    shared: Arc<Shared>,
}

impl Consumer {
    /// The next event, waiting for one if the queue is empty. `None` once the
    /// producer is gone and everything it queued has been taken.
    pub fn recv(&self) -> Option<PtyEvent> {
        let mut state = self.shared.state.lock().expect("output queue poisoned");
        loop {
            if let Some(event) = state.take() {
                return Some(event);
            }
            if state.producer_gone {
                return None;
            }
            state = self
                .shared
                .ready
                .wait(state)
                .expect("output queue poisoned");
        }
    }

    /// [`recv`](Self::recv) with a deadline. `None` means nothing arrived in
    /// time, or the producer is gone and the queue is drained — a caller that
    /// needs to tell those apart is waiting for a specific event and will
    /// recognise it when it comes.
    pub fn recv_timeout(&self, timeout: Duration) -> Option<PtyEvent> {
        let deadline = Instant::now() + timeout;
        let mut state = self.shared.state.lock().expect("output queue poisoned");
        loop {
            if let Some(event) = state.take() {
                return Some(event);
            }
            if state.producer_gone {
                return None;
            }
            let remaining = deadline.checked_duration_since(Instant::now())?;
            let (next, _) = self
                .shared
                .ready
                .wait_timeout(state, remaining)
                .expect("output queue poisoned");
            state = next;
        }
    }
}

impl Drop for Consumer {
    fn drop(&mut self) {
        let mut state = self.shared.state.lock().expect("output queue poisoned");
        state.consumer_gone = true;
        // Whatever is still queued has nowhere to go; releasing it here keeps a
        // closed session from holding megabytes until the producer notices.
        state.chunks.clear();
        state.queued = 0;
    }
}

impl State {
    /// Add `bytes` to the newest pending chunk, or start a new one.
    fn append(&mut self, bytes: Vec<u8>) {
        self.queued += bytes.len();
        match self.chunks.back_mut() {
            Some(tail) if tail.len() + bytes.len() <= COALESCE_MAX_BYTES => {
                tail.extend_from_slice(&bytes);
            }
            _ => self.chunks.push_back(bytes),
        }
    }

    /// Drop the oldest chunks until the queue fits again.
    fn evict_to_cap(&mut self) {
        let mut dropped = 0;
        while self.queued > self.cap {
            match self.chunks.pop_front() {
                Some(chunk) => {
                    self.queued -= chunk.len();
                    dropped += chunk.len();
                }
                // Only reachable with a cap smaller than a single chunk, which
                // the queue is not configured with.
                None => break,
            }
        }
        self.dropped += dropped;
    }

    /// The next event to hand out, if there is one.
    fn take(&mut self) -> Option<PtyEvent> {
        if self.dropped > 0 {
            // The gap is at the front of what survived, so it is announced
            // before the bytes that outlived it.
            return Some(PtyEvent::Output(drop_marker(std::mem::take(
                &mut self.dropped,
            ))));
        }
        if let Some(chunk) = self.chunks.pop_front() {
            self.queued -= chunk.len();
            return Some(PtyEvent::Output(chunk));
        }
        self.exited.take().map(PtyEvent::Exited)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn queue(cap: usize) -> (Producer, Consumer) {
        OutputQueue::new(cap).split()
    }

    fn drain_output(consumer: &Consumer) -> Vec<Vec<u8>> {
        let mut seen = Vec::new();
        while let Some(event) = consumer.recv_timeout(Duration::from_millis(50)) {
            match event {
                PtyEvent::Output(bytes) => seen.push(bytes),
                PtyEvent::Exited(_) => break,
            }
        }
        seen
    }

    #[test]
    fn coalescing_preserves_content() {
        let (producer, consumer) = queue(OUTPUT_CAP_BYTES);
        for chunk in [b"one ".as_slice(), b"two ", b"three"] {
            assert_eq!(
                producer.push(PtyEvent::Output(chunk.to_vec())),
                PushOutcome::Enqueued
            );
        }
        drop(producer);

        let joined: Vec<u8> = drain_output(&consumer).concat();
        assert_eq!(joined, b"one two three");
    }

    #[test]
    fn cap_evicts_oldest_and_announces_the_gap() {
        // A cap under one chunk would have nothing left to keep, so the cap is
        // two chunks wide and the third one pushes the first out.
        let (producer, consumer) = queue(COALESCE_MAX_BYTES * 2);
        let chunk = vec![b'x'; COALESCE_MAX_BYTES];
        for _ in 0..3 {
            assert_eq!(
                producer.push(PtyEvent::Output(chunk.clone())),
                PushOutcome::Enqueued,
                "the producer's answer does not change when the cap bites"
            );
        }
        drop(producer);

        let seen = drain_output(&consumer);
        assert_eq!(
            parse_drop_marker(&seen[0]),
            Some(COALESCE_MAX_BYTES),
            "the gap is announced before the bytes that outlived it"
        );
        let kept: usize = seen[1..].iter().map(Vec::len).sum();
        assert_eq!(kept, COALESCE_MAX_BYTES * 2, "the cap is respected");
    }

    #[test]
    fn one_marker_per_run_of_drops() {
        let (producer, consumer) = queue(COALESCE_MAX_BYTES);
        let chunk = vec![b'x'; COALESCE_MAX_BYTES];
        for _ in 0..4 {
            producer.push(PtyEvent::Output(chunk.clone()));
        }
        drop(producer);

        let markers = drain_output(&consumer)
            .iter()
            .filter(|chunk| parse_drop_marker(chunk).is_some())
            .count();
        assert_eq!(markers, 1);
    }

    #[test]
    fn ordinary_output_is_never_read_as_a_marker() {
        assert_eq!(parse_drop_marker(b"hello"), None);
        // The wording embedded in real output stays real output.
        let mut embedded = b"log: ".to_vec();
        embedded.extend_from_slice(&drop_marker(12));
        assert_eq!(parse_drop_marker(&embedded), None);
        // The shape without a count is not a marker either.
        let mut countless = MARKER_HEAD.to_vec();
        countless.extend_from_slice(MARKER_TAIL);
        assert_eq!(parse_drop_marker(&countless), None);
        assert_eq!(parse_drop_marker(&drop_marker(4096)), Some(4096));
    }

    #[test]
    fn output_precedes_the_exit_even_when_coalesced() {
        let (producer, consumer) = queue(OUTPUT_CAP_BYTES);
        producer.push(PtyEvent::Output(b"a".to_vec()));
        producer.push(PtyEvent::Output(b"b".to_vec()));
        producer.push(PtyEvent::Exited(ExitInfo {
            success: true,
            code: Some(0),
        }));
        drop(producer);

        assert_eq!(
            consumer.recv(),
            Some(PtyEvent::Output(b"ab".to_vec())),
            "pending output is handed over before the exit"
        );
        assert!(matches!(consumer.recv(), Some(PtyEvent::Exited(_))));
        assert_eq!(consumer.recv(), None, "nothing follows the exit");
    }

    #[test]
    fn a_dropped_consumer_is_reported_to_the_producer() {
        let (producer, consumer) = queue(OUTPUT_CAP_BYTES);
        producer.push(PtyEvent::Output(b"before".to_vec()));
        drop(consumer);

        assert_eq!(
            producer.push(PtyEvent::Output(b"after".to_vec())),
            PushOutcome::ConsumerGone
        );
    }
}
