//! Fleet artifacts: workspace-scoped persistence + the localhost display
//! server (slice 5). The store owns the disk FORMAT; the TS domain owns
//! the rules' canonical definitions; this module is their Rust home.
//!
//! The re-exports below are the slice-4 command layer's surface — unused
//! until those commands register, by design (slices land in order).

mod claim;
mod store;

#[allow(unused_imports)]
pub use store::{
    ArtifactFormat, ArtifactMeta, ArtifactsStore, DeleteOutcome, PublishIdentity,
    PublishOutcome, PublishRequest, ReadResult, StoreError,
};
