//! The durable usage ledger.
//!
//! Panes report how much their provider sessions have used SO FAR; this crate
//! turns each report into what it adds ([`delta`]), stores it ([`store`]) and
//! hands the webview a ledger it can hold: history compacted into
//! quarter-hour buckets, the last hours raw. The webview's stats, charts and
//! achievements fold those rows; they used to fold half a million raw events
//! held in the page.

pub mod delta;
mod event_id;
pub mod import;
pub mod model;
pub mod store;

pub use import::{import_jsonl, ImportReport};
pub use model::{CaptureContext, LedgerRow, UsageReport};
pub use store::{Ledger, UsageStore};
