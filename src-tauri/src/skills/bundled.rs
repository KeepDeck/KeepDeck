//! The bundled skills tier: first-party skills whose canonical content
//! ships inside the binary. Read-only, served from memory at query
//! time, never written into the user's library (the design contract:
//! docs/bundled-skills-design.md — sections are namespaces at rest,
//! resolution-by-name happens only in staging).
//!
//! The GATE boundary: staging LOGIC stays feature-free — it takes a plain
//! `claimed: bool`; only the tauri glue (skills_stage) resolves the registry
//! and computes the bool. One-directional, testable with a literal.

use super::GateKey;

/// One bundled skill. SINGLE-FILE by boundary (SKILL.md only — a real
/// multi-file need earns a virtual-source concept, not a silent
/// widening of this struct). `gate`: None is always armed; Some gate is
/// armed only while that gate resolves true (the design §3 per-skill gate —
/// the second bundled skill must not refactor the first one's filter).
pub(crate) struct BundledSkill {
    pub(crate) name: &'static str,
    pub(crate) content: &'static str,
    pub(crate) gate: Option<GateKey>,
}

/// The tier. Every entry ships; `gate` decides arming, never presence.
pub(crate) const BUNDLED: &[BundledSkill] = &[BundledSkill {
    name: "artifacts",
    content: include_str!("bundled/artifacts/SKILL.md"),
    gate: Some(GateKey::Artifacts),
}];

#[cfg(test)]
mod tests {
    use super::*;

    /// Names pass the ACTUAL library wall — not a re-implemented regex
    /// (the twin-drift rule: two walls drift apart silently).
    #[test]
    fn names_pass_the_library_wall() {
        for skill in BUNDLED {
            assert!(
                crate::skills::library::require_safe(skill.name, "bundled skill name").is_ok(),
                "{} must pass the library wall", skill.name
            );
        }
    }

    #[test]
    fn no_duplicate_names_within_the_tier() {
        let mut seen = std::collections::HashSet::new();
        for skill in BUNDLED {
            assert!(seen.insert(skill.name), "duplicate bundled name {}", skill.name);
        }
    }

    /// The tier's shape: exactly the artifacts skill, gated — pinned so a
    /// second entry's arrival is a deliberate act, not an accident.
    #[test]
    fn the_tier_is_what_it_claims() {
        assert_eq!(BUNDLED.len(), 1);
        assert_eq!(BUNDLED[0].name, "artifacts");
        assert_eq!(BUNDLED[0].gate, Some(GateKey::Artifacts));
    }

}
