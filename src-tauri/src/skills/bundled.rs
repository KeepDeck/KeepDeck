//! The bundled skills tier: first-party skills whose canonical content
//! ships inside the binary. Read-only, served from memory at query
//! time, never written into the user's library (the design contract:
//! docs/bundled-skills-design.md — sections are namespaces at rest,
//! resolution-by-name happens only in staging).
//!
//! The GATE boundary: staging LOGIC stays artifacts-free — it takes a
//! plain `claimed: bool`; only the tauri glue (skills_stage) imports
//! the artifacts state and computes the bool. One-directional, testable
//! with a literal, no fn machinery.

/// One bundled skill. SINGLE-FILE by boundary (SKILL.md only — a real
/// multi-file need earns a virtual-source concept, not a silent
/// widening of this struct). `gated`: armed only while the claim probe
/// is true (the design §3 per-skill gate — the second bundled skill
/// must not refactor the first one's filter).
pub(crate) struct BundledSkill {
    pub(crate) name: &'static str,
    pub(crate) content: &'static str,
    pub(crate) gated: bool,
}

/// The tier. Every entry ships; `gated` decides arming, never presence.
pub(crate) const BUNDLED: &[BundledSkill] = &[BundledSkill {
    name: "artifacts",
    content: include_str!("bundled/artifacts/SKILL.md"),
    gated: true,
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

    /// The byte-contract pin: the shipped skill carries the live-refresh
    /// lines in the same shape the display server's template injects —
    /// CONTAINS (the skill embeds the script inside prose/fencing), not
    /// byte-equality; "byte-identical" describes the content MOVE only.
    #[test]
    fn content_carries_the_live_refresh_contract() {
        for skill in BUNDLED {
            assert!(
                skill
                    .content
                    .contains("EventSource(location.pathname+\"/events\"+location.search)"),
                "{}: the pin-preserving subscribe line must ship verbatim", skill.name
            );
            assert!(
                skill.content.contains("es.addEventListener(\"error\""),
                "{}: the error arm must ship verbatim", skill.name
            );
            assert!(
                skill.content.contains("es.addEventListener(\"version\",()=>location.reload())"),
                "{}: the reload-on-version line must ship verbatim", skill.name
            );
        }
    }

    /// The tier's shape: exactly the artifacts skill, gated — pinned so a
    /// second entry's arrival is a deliberate act, not an accident.
    #[test]
    fn the_tier_is_what_it_claims() {
        assert_eq!(BUNDLED.len(), 1);
        assert_eq!(BUNDLED[0].name, "artifacts");
        assert!(BUNDLED[0].gated);
    }

    /// INTEGRATION (the §F cross-module contract, pinned end-to-end):
    /// every SCRIPT LINE the display server's template injects into
    /// rendered md pages must appear in the bundled skill's teaching
    /// snippet VERBATIM — the server is the source of truth; if this
    /// fails, the skill ships a refresh contract the server no longer
    /// honors (agents would embed a broken page). The extracted
    /// template lines are the non-prose, non-blank lines of the
    /// snippet: the exact JS the browser executes.
    #[test]
    fn the_skill_snippet_matches_the_server_template_lines() {
        let taught = BUNDLED
            .iter()
            .find(|skill| skill.name == "artifacts")
            .expect("the artifacts skill ships");
        // Extract the executed-JS lines from the server's snippet: strip
        // the <script> wrapper, drop blank lines and the note's prose
        // strings (the skill's prose framing may differ; the CONTRACT is
        // the ES lines: subscribe, three listeners, close-on-bye/error).
        let js_lines: Vec<&str> = crate::artifacts::serve::LIVE_REFRESH_SNIPPET
            .lines()
            .map(str::trim)
            .filter(|line| {
                !line.is_empty()
                    && !line.starts_with("<")
                    && !line.contains("textContent")
                    && !line.contains("setAttribute")
            })
            .collect();
        assert!(!js_lines.is_empty(), "extraction sanity");
        for line in js_lines {
            assert!(
                taught.content.contains(line),
                "the skill must teach the server's line verbatim:\n{line}"
            );
        }
    }
}
