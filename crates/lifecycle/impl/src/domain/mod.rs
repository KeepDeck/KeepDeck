//! The lifecycle's rules: the machine, the operations it runs, what it knows
//! of the world, and what an unfinished operation owes. Pure — no IO, no
//! clock, no threads, nothing from [`crate::infrastructure`].

pub mod command;
pub mod dir;
pub mod doors;
pub mod ids;
pub mod journal;
pub mod machine;
pub mod model;
pub mod places;
pub mod single;
pub mod world;
