//! The durable usage ledger.
//!
//! Agents' plugins report the provider API calls their sessions make; this
//! crate books each call once ([`store`]), keeps a journal of the model
//! makers' list prices ([`catalogue`]) and prices the usage from it as the
//! ledger is served ([`pricing`]). The webview's stats, charts and
//! achievements fold the rows it serves: history compacted into quarter-hour
//! buckets, the last hours raw.

pub mod catalogue;
mod legacy;
pub mod model;
pub mod pricing;
pub mod store;

pub use model::{CallBatch, LedgerRow, Place, UsageCall};
pub use store::{Ledger, UsageStore};
