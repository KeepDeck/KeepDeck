//! What the read budget costs in MEMORY, not just in what it returns.
//!
//! Its own file on purpose. Cargo builds every integration test as its own
//! binary, so the counting allocator below sees this test's allocations and
//! nothing else's; in the crate's unit-test module it would be measuring
//! twenty-seven other tests at the same time and could assert nothing.
//!
//! What it pins: a cell larger than the whole budget is refused WITHOUT
//! being allocated. Weighing a row after materializing it would return the
//! same answer — empty and short — while having briefly held the entire
//! cell, which is the one failure a byte ceiling exists to prevent. Only a
//! peak measurement can tell those two apart.

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use rusqlite::Connection;

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let live = LIVE.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
        PEAK.fetch_max(live, Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

const CELL_BYTES: usize = 64 * 1024 * 1024;
/// Four times the noise floor and sixteen times under the cell: the assert
/// cannot be satisfied by a run that copied the value, nor broken by the
/// ordinary allocation a query makes.
const CEILING: usize = 16 * 1024 * 1024;

/// Measure the peak Rust allocation across one call, from a clean mark.
fn peak_of<T>(f: impl FnOnce() -> T) -> (T, usize) {
    PEAK.store(LIVE.load(Ordering::Relaxed), Ordering::Relaxed);
    let before = PEAK.load(Ordering::Relaxed);
    let value = f();
    (value, PEAK.load(Ordering::Relaxed).saturating_sub(before))
}

#[test]
fn a_cell_larger_than_the_budget_is_refused_without_being_allocated() {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("huge.db");
    {
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE huge (t TEXT, b BLOB);")
            .unwrap();
        let text = "x".repeat(CELL_BYTES);
        conn.execute("INSERT INTO huge (t) VALUES (?1)", [&text])
            .unwrap();
        conn.execute("INSERT INTO huge (b) VALUES (?1)", [text.as_bytes()])
            .unwrap();
    }

    // Text and blob separately: they take different arms of the weighing,
    // and the blob one is the newer claim — it is weighed by its real size
    // rather than by the six-byte placeholder it would be carried as.
    for column in ["t", "b"] {
        let (read, peak) = peak_of(|| {
            keepdeck_index::query_readonly(
                &db,
                &format!("SELECT {column} FROM huge WHERE {column} IS NOT NULL"),
                &[],
            )
            .unwrap()
        });
        assert!(read.rows.is_empty(), "{column}: the row does not fit");
        assert!(read.short, "{column}: and the answer says so");
        assert!(
            peak < CEILING,
            "{column}: peak {peak} — the cell was allocated before it was weighed",
        );
    }
}
