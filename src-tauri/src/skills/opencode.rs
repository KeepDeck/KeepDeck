//! The user-facing half of the opencode view: one generated `/name` command
//! per staged skill.
//!
//! opencode surfaces no skill listing and no slash form of its own, so a
//! loaded skill would be invisible in its UI. Each skill therefore doubles as
//! a palette command whose description is the skill's own and whose body
//! POINTS AT the staged SKILL.md rather than inlining it — a reference cannot
//! go stale when the skill is edited.

use std::path::Path;

/// The generated `/name` command for opencode.
pub(super) fn command(name: &str, content: &str, staged_skill: &Path) -> String {
    let description = frontmatter_line(content, "description").unwrap_or_default();
    format!(
        "---\ndescription: {description}\n---\nUse the \"{name}\" skill: read {} and follow its \
         instructions for this request: $ARGUMENTS\n",
        staged_skill.display(),
    )
}

/// Best-effort raw value of one `key:` line inside the frontmatter fence.
/// Schema knowledge stays TS-side — this lifts a line the library already
/// stores as valid YAML and re-emits it VERBATIM (quoting untouched).
/// COUPLING PIN: this depends on descriptions being single-line, which
/// only the TS side enforces — the `"multiline"` arm of
/// `skillDescriptionProblem` in src/domain/skills/skills.ts. If TS ever
/// allows multi-line or block scalars, this lift breaks — the pin test
/// below and the note on that verdict mark the contract on both sides.
fn frontmatter_line(content: &str, key: &str) -> Option<String> {
    // CRLF-tolerant like the TS parser (the coupling pin's other side): a
    // hand-edited Windows-style file must not lose its description here.
    let normalized = content.replace("\r\n", "\n");
    let rest = normalized.strip_prefix("---\n")?;
    let fence = rest.find("\n---\n")?;
    rest[..fence].lines().find_map(|line| {
        line.strip_prefix(key)?
            .strip_prefix(':')
            .map(|value| value.trim().to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_lift_is_verbatim_and_single_line_pinned() {
        // COUPLING PIN with src/domain/skills/skills.ts: descriptions are
        // single-line (TS enforces) and the lift re-emits the scalar
        // VERBATIM, quoting untouched.
        let content = "---\nname: x\ndescription: \"Use when: it's risky\"\n---\nB\n";
        assert_eq!(
            frontmatter_line(content, "description").as_deref(),
            Some("\"Use when: it's risky\""),
        );
        let generated = command("x", content, Path::new("/staged/SKILL.md"));
        assert!(generated.starts_with("---\ndescription: \"Use when: it's risky\"\n---\n"));

        // CRLF row of the pin: the lift must read Windows-style files the
        // way the TS parser does, not return an empty description.
        let crlf = "---\r\nname: x\r\ndescription: Ships it\r\n---\r\nB\r\n";
        assert_eq!(frontmatter_line(crlf, "description").as_deref(), Some("Ships it"));
    }
}
