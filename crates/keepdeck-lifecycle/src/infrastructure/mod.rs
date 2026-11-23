//! What the lifecycle's rules need from the world, done: the journal on disk,
//! the handler that carries out the machine's effects, the waiting door, and
//! the machine started on them.

pub mod door;
pub mod handler;
pub mod journal;
pub mod machine;
pub mod store;
