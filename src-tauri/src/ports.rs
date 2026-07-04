//! Deterministic per-worktree port blocks for run presets.
//!
//! A run pane gets `KEEPDECK_PORT` = the base of a contiguous block of
//! [`BLOCK`] ports derived from its worktree path, so the same worktree
//! comes back to the same ports across restarts without any ledger to go
//! stale; a taken block linear-probes to the next. "Free" means bindable
//! on 127.0.0.1 right now — best-effort by design (the window until the
//! preset's own server binds is the same one every port-picking tool has).
//! Nothing here ever signals another process: a busy port is simply
//! someone else's.

use std::net::TcpListener;

/// First managed port; blocks of [`BLOCK`] cover `17000..19000`.
const RANGE_START: u16 = 17_000;
/// Number of blocks in the managed range.
const BLOCKS: u16 = 200;
/// Ports per block: the base is the app's, base+1..+9 are for its helpers
/// (API, HMR, debugger...).
const BLOCK: u16 = 10;

/// FNV-1a — tiny, dependency-free, stable across platforms and runs.
fn fnv1a(key: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in key.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn block_base(index: u16) -> u16 {
    RANGE_START + index * BLOCK
}

/// The base of the first fully-free block, starting at `key`'s hash slot and
/// probing forward with wrap-around; `None` when every block is taken.
/// `free` is injected so the search is testable without real sockets.
fn allocate_with(key: &str, free: impl Fn(u16) -> bool) -> Option<u16> {
    let start = (fnv1a(key) % u64::from(BLOCKS)) as u16;
    (0..BLOCKS)
        .map(|i| block_base((start + i) % BLOCKS))
        .find(|&base| (base..base + BLOCK).all(&free))
}

fn bindable(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// `KEEPDECK_PORT` for the worktree identified by `key` (its absolute path):
/// the deterministic 10-port block base described in the module docs.
#[tauri::command(async)]
pub fn ports_allocate(key: String) -> Result<u16, String> {
    allocate_with(&key, bindable)
        .ok_or_else(|| format!("no free port block in {RANGE_START}..{}", block_base(BLOCKS)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_key_same_block() {
        let a = allocate_with("/repos/kd/wt-1", |_| true).unwrap();
        let b = allocate_with("/repos/kd/wt-1", |_| true).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn bases_are_block_aligned_and_in_range() {
        for key in ["/a", "/b", "/c/deep/worktree", ""] {
            let base = allocate_with(key, |_| true).unwrap();
            assert_eq!((base - RANGE_START) % BLOCK, 0, "misaligned for {key}");
            assert!((RANGE_START..block_base(BLOCKS)).contains(&base));
        }
    }

    #[test]
    fn busy_block_probes_to_the_next() {
        let preferred = allocate_with("/repos/kd/wt-2", |_| true).unwrap();
        // One busy port anywhere in the block disqualifies the whole block.
        let busy = preferred + BLOCK - 1;
        let base = allocate_with("/repos/kd/wt-2", |p| p != busy).unwrap();
        assert_ne!(base, preferred);
        // The probe moves exactly one block forward (wrapping at the end).
        let expected = if preferred + BLOCK >= block_base(BLOCKS) {
            RANGE_START
        } else {
            preferred + BLOCK
        };
        assert_eq!(base, expected);
    }

    #[test]
    fn wraps_past_the_range_end() {
        let preferred = allocate_with("/repos/kd/wt-3", |_| true).unwrap();
        // Everything from the preferred block to the end is busy → wrap to
        // the range start.
        let base = allocate_with("/repos/kd/wt-3", |p| p < preferred).unwrap();
        assert_eq!(base, RANGE_START);
    }

    #[test]
    fn exhausted_range_returns_none() {
        assert_eq!(allocate_with("/repos/kd/wt-4", |_| false), None);
    }

    #[test]
    fn real_bind_probe_allocates_in_range() {
        // Smoke test over real sockets: whatever is free on this machine,
        // the answer stays block-aligned and in range.
        let base = allocate_with("/smoke", bindable).expect("a free block");
        assert_eq!((base - RANGE_START) % BLOCK, 0);
        assert!((RANGE_START..block_base(BLOCKS)).contains(&base));
    }
}
