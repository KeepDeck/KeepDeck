//! The localhost HTTP machinery, owned by nobody in particular and used by
//! everyone who needs a local surface.
//!
//! It lived inside `artifacts/` until the bridge needed the same thing, and
//! the move is a correction rather than a convenience: the artifacts feature
//! never owned this code, it was merely the first to need it. Placement
//! follows OWNERSHIP — state, lifecycle, port — and a request parser owns
//! none of the artifacts feature's.
//!
//! What lives here is exactly what has no consumer-specific knowledge: the
//! bounded head parse, percent-decoding, and the two response shapes. What
//! does NOT live here is routing — a route table is the consumer's own
//! vocabulary, and a shared module that knew `/a/<token>/<slug>` would be
//! the same smear it was extracted to end.
//!
//! std-only, like the code it came from: there is no HTTP crate in the tree
//! and this is not the commit that adds one.

pub(crate) mod listener;
pub(crate) mod request;
pub(crate) mod response;

pub(crate) use listener::{bind, Listener};
pub(crate) use request::{read_request, Limits};
pub(crate) use response::{respond_empty, respond_with_body};
