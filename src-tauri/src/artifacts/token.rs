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
