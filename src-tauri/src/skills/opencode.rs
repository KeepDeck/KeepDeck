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
///
/// COUPLING PIN with `frontmatterSpan`/`parseSkillFile` in
/// src/domain/skills/skillFile.ts. TS reads this file with a real YAML
/// parser and only ever WRITES the simplest shape, so this lift has to
/// understand what TS TOLERATES on read, not merely what it writes:
/// a fence with trailing spaces, a fence at end of file, and a folded or
/// literal block scalar. Each of those is a shape TS reads and preserves
/// indefinitely (a rename splices, it does not re-compose), so a stricter
/// reader here silently generates an opencode command with no description.
/// Extend both sides together.
fn frontmatter_line(content: &str, key: &str) -> Option<String> {
    // CRLF-tolerant like the TS parser: a hand-edited Windows-style file must
    // not lose its description here.
    let normalized = content.replace("\r\n", "\n");
    let rest = fenced(&normalized)?;
    let mut lines = rest.lines();
    while let Some(line) = lines.next() {
        let Some(value) = line.strip_prefix(key).and_then(|r| r.strip_prefix(':')) else {
            continue;
        };
        let value = value.trim();
        // A block scalar's value is the INDENTED lines under its header, folded
        // onto the one line this schema says a value is — the same fold TS does.
        if value.starts_with('>') || value.starts_with('|') {
            let folded: Vec<String> = lines
                .take_while(|l| l.trim().is_empty() || l.starts_with([' ', '\t']))
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
            return Some(folded.join(" "));
        }
        return Some(value.to_string());
    }
    None
}

/// The frontmatter's own lines, or `None` when the file has no fenced block.
/// Tolerates trailing spaces on either fence and a closing fence at end of
/// file, matching what the TS side accepts.
fn fenced(normalized: &str) -> Option<&str> {
    let open = normalized.strip_prefix("---")?;
    let rest = open.strip_prefix('\n').or_else(|| {
        let trimmed = open.trim_start_matches([' ', '\t']);
        trimmed.strip_prefix('\n')
    })?;
    let mut at = 0;
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            return Some(&rest[..at]);
        }
        at += line.len();
    }
    // A closing fence at end of file, with no newline after it.
    if rest[at..].trim_end() == "---" {
        return Some(&rest[..at]);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lift_reads_every_shape_the_ts_side_tolerates() {
        // The pin's other half. TS reads this file with a real YAML parser and a
        // rename SPLICES rather than re-composing, so each of these survives on
        // disk indefinitely — a stricter reader here would ship an opencode
        // command with an empty description for a skill that has one.
        for (label, content) in [
            ("plain", "---\nname: x\ndescription: Reviews\n---\nB\n"),
            ("open fence padded", "--- \nname: x\ndescription: Reviews\n---\nB\n"),
            ("close fence padded", "---\nname: x\ndescription: Reviews\n---  \nB\n"),
            ("close fence at EOF", "---\nname: x\ndescription: Reviews\n---"),
            ("crlf", "---\r\nname: x\r\ndescription: Reviews\r\n---\r\nB\r\n"),
        ] {
            assert_eq!(
                frontmatter_line(content, "description").as_deref(),
                Some("Reviews"),
                "{label}",
            );
        }
        // A block scalar folds onto its one line, the same fold TS performs.
        for (label, content) in [
            ("folded", "---\ndescription: >\n  Reviews a\n  diff\n---\nB\n"),
            ("literal chomped", "---\ndescription: |-\n  Reviews a\n  diff\n---\nB\n"),
            ("indicator first", "---\ndescription: >2-\n  Reviews a\n  diff\n---\nB\n"),
        ] {
            assert_eq!(
                frontmatter_line(content, "description").as_deref(),
                Some("Reviews a diff"),
                "{label}",
            );
        }
        // And a block scalar ends at the next top-level key, not at the fence.
        assert_eq!(
            frontmatter_line("---\ndescription: >\n  folded\nname: x\n---\nB\n", "name")
                .as_deref(),
            Some("x"),
        );
    }

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
