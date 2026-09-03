//! Token mint + constant-time comparison (B5).
//!
//! Mint: `uuid` v4 — the SAME entropy class as the TS side's
//! `crypto.randomUUID()` (the spawn secrets' class), already a direct
//! dependency. Comparison: hash both sides with sha2 (already a dep) and
//! compare digests — one helper, no timing signal at the compare site.

use sha2::{Digest, Sha256};
use uuid::Uuid;

/// An unguessable path-segment token.
pub(super) fn mint_token() -> String {
    Uuid::new_v4().simple().to_string()
}

/// The artifact's GENERATION: a stable, opaque name for this incarnation
/// of a slug, safe to hand outside.
///
/// Derived from the token because the token is exactly what changes when
/// a deleted slug is republished — the store calls that a resurrection,
/// and the whole point of a generation is to tell the two apart. It is a
/// one-way digest, never the token itself: B10 keeps the raw token off
/// every surface but the URL, since a token IS the URL's authority,
/// while this cannot address anything.
///
/// Short on purpose. A conditional delete compares two of these; it is
/// not a secret and needs no more room than it takes to be different.
pub(super) fn generation_of(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

/// Constant-time equality for token comparison: length differences are
/// absorbed by the hash, the digest compare is fixed-shape.
pub(super) fn token_eq(a: &str, b: &str) -> bool {
    let da = Sha256::digest(a.as_bytes());
    let db = Sha256::digest(b.as_bytes());
    da.as_slice() == db.as_slice()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minted_tokens_are_path_safe_and_distinct() {
        let a = mint_token();
        let b = mint_token();
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn token_eq_compares_by_value_not_identity() {
        assert!(token_eq("secret", "secret"));
        assert!(!token_eq("secret", "secreu"));
        assert!(!token_eq("secret", "secret-with-suffix"));
        assert!(!token_eq("", "x"));
    }
}
