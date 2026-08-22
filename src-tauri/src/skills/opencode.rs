//! The user-facing half of the opencode view: one generated `/name` command
//! per staged skill.
//!
//! opencode surfaces no skill listing and no slash form of its own, so a
//! loaded skill would be invisible in its UI. Each skill therefore doubles as
//! a palette command whose description is the skill's own and whose body
//! POINTS AT the staged SKILL.md rather than inlining it — a reference cannot
//! go stale when the skill is edited.

use std::io;
use std::path::{Path, PathBuf};

use crate::state::write_atomic;

/// How the swap is performed. The MECHANISM is staging's — one atomic
/// directory replacement, used by every view — while the tmp and trash
/// names below are this dialect's own.
pub(super) type SwapDir = fn(&Path, &Path, &Path) -> io::Result<()>;

/// opencode's view of a workspace's skills, through its whole lifecycle.
///
/// It lives OUTSIDE the wiped `staging/` tree: opencode treats its config
/// dir as writable (node_modules, account state) and those files must
/// survive every rebuild — only the two subtrees named here are ours.
pub(super) struct View {
    dir: PathBuf,
    skills_tmp: PathBuf,
    command_tmp: PathBuf,
}

impl View {
    /// Where every workspace's opencode view lives — the prune sweep asks
    /// for it rather than spelling this dialect's directory itself.
    pub(super) fn parent(root: &Path) -> PathBuf {
        root.join("opencode")
    }

    pub(super) fn at(root: &Path, ws_id: &str) -> Self {
        let dir = Self::parent(root).join(ws_id);
        Self {
            skills_tmp: dir.join(".skills-tmp"),
            command_tmp: dir.join(".command-tmp"),
            dir,
        }
    }

    /// The path the DTO carries to the spawn (`OPENCODE_CONFIG_DIR`).
    pub(super) fn config_dir(&self) -> &Path {
        &self.dir
    }

    /// Where a skill's SKILL.md copy is staged.
    pub(super) fn skills_tmp(&self) -> &Path {
        &self.skills_tmp
    }

    /// The subtrees an emptied library must take with it — and only
    /// those: opencode's own files sit beside them.
    pub(super) fn ours(&self) -> [PathBuf; 2] {
        [self.dir.join("skills"), self.dir.join("command")]
    }

    /// Clear yesterday's staging dirs before a rebuild.
    pub(super) fn prepare(&self) -> io::Result<()> {
        for stale in [&self.skills_tmp, &self.command_tmp] {
            match std::fs::remove_dir_all(stale) {
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                other => other?,
            }
        }
        Ok(())
    }

    /// One `/name` command per skill — the user-facing half.
    pub(super) fn emit(&self, name: &str, content: &str, skill_file: &str) -> io::Result<()> {
        let staged_skill = self.dir.join("skills").join(name).join(skill_file);
        write_atomic(
            &self.command_tmp.join(format!("{name}.md")),
            command(name, content, &staged_skill).as_bytes(),
        )
    }

    /// Land both subtrees.
    pub(super) fn finalize(&self, swap: SwapDir) -> io::Result<()> {
        swap(&self.skills_tmp, &self.dir.join("skills"), &self.dir.join(".old-skills"))?;
        swap(&self.command_tmp, &self.dir.join("command"), &self.dir.join(".old-command"))
    }
}

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
/// `pub(super)`: staging's collection guard judges SKILLS by the SAME
/// lift the command generator uses — one reader, so the guard and the
/// generator cannot drift apart on what a usable description is.
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
pub(super) fn frontmatter_line(content: &str, key: &str) -> Option<String> {
    // CRLF-tolerant like the TS parser: a hand-edited Windows-style file must
    // not lose its description here.
    let normalized = content.replace("\r\n", "\n");
    let rest = fenced(&normalized)?;
    // LAST match wins, matching the TS side and a lenient YAML reader: a file that
    // states the key twice is refused for WRITING, so it stays on disk, and the app
    // and this lift must not disagree about what it says.
    let mut found: Option<String> = None;
    let mut lines = rest.lines();
    while let Some(line) = lines.next() {
        let Some(value) = line.strip_prefix(key).and_then(|r| r.strip_prefix(':')) else {
            continue;
        };
        let value = value.trim();
        // A block scalar's value is the INDENTED lines under its header, folded
        // onto the one line this schema says a value is — the same fold TS does.
        //
        // QUOTED, unlike the single-line arm. That arm re-emits the stored scalar
        // verbatim, so its quoting is already whatever the author wrote; this one
        // SYNTHESIZES a plain scalar, and a folded description containing `": "`
        // then made the generated command's own frontmatter unparseable, while one
        // containing `" #"` was silently truncated at the comment.
        if value.starts_with('>') || value.starts_with('|') {
            let folded: Vec<String> = lines
                .by_ref()
                .take_while(|l| l.trim().is_empty() || l.starts_with([' ', '\t']))
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
            found = Some(double_quoted(&folded.join(" ")));
            continue;
        }
        found = Some(value.to_string());
    }
    found
}

/// A YAML double-quoted scalar. Only the two characters that can end it early
/// need escaping for a value we folded onto one line.
fn double_quoted(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

/// The frontmatter's own lines, or `None` when the file has no fenced block.
/// Tolerates trailing spaces on either fence and a closing fence at end of
/// file, matching what the TS side accepts.
fn fenced(normalized: &str) -> Option<&str> {
    // A leading BOM is part of the fence, as it is on the TS side: without this the
    // lift saw no frontmatter in a BOM'd file that TS reads and preserves happily,
    // and the generated command got an empty description.
    let open = normalized
        .strip_prefix('\u{feff}')
        .unwrap_or(normalized)
        .strip_prefix("---")?;
    let rest = open.strip_prefix('\n').or_else(|| {
        let trimmed = open.trim_start_matches([' ', '\t']);
        trimmed.strip_prefix('\n')
    })?;
    let mut at = 0;
    // `split_inclusive` yields the trailing unterminated line too, so a closing
    // fence at end of file is handled here and needs no separate branch after the
    // loop — one was written and was dead.
    for line in rest.split_inclusive('\n') {
        if line.trim_end() == "---" {
            return Some(&rest[..at]);
        }
        at += line.len();
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
        // A block scalar folds onto its one line, the same fold TS performs — and is
        // QUOTED, because unlike the single-line arm this value is synthesized. A
        // plain `description: Use when: risky` made the generated command's own
        // frontmatter unparseable, and `Use #1 tool` truncated it at the comment.
        for (label, content) in [
            ("folded", "---\ndescription: >\n  Reviews a\n  diff\n---\nB\n"),
            ("literal chomped", "---\ndescription: |-\n  Reviews a\n  diff\n---\nB\n"),
            ("indicator first", "---\ndescription: >2-\n  Reviews a\n  diff\n---\nB\n"),
        ] {
            assert_eq!(
                frontmatter_line(content, "description").as_deref(),
                Some("\"Reviews a diff\""),
                "{label}",
            );
        }
        for (label, content) in [
            ("colon", "---\ndescription: |\n  Use when: risky\n---\nB\n"),
            ("hash", "---\ndescription: >\n  Use #1 tool\n---\nB\n"),
            ("quote", "---\ndescription: |\n  Say \"go\"\n---\nB\n"),
        ] {
            let lifted = frontmatter_line(content, "description").expect(label);
            let generated = command("x", content, Path::new("/staged/SKILL.md"));
            assert!(generated.contains(&format!("description: {lifted}")), "{label}");
            // The generated frontmatter is a mapping a reader can still parse: the
            // value is quoted, so neither `: ` nor ` #` can end it early.
            assert!(lifted.starts_with('"') && lifted.ends_with('"'), "{label}");
        }
        // A BOM is part of the fence here as it is in TS, or the command would be
        // generated with no description at all.
        assert_eq!(
            frontmatter_line("\u{feff}---\nname: x\ndescription: R\n---\nB\n", "description")
                .as_deref(),
            Some("R"),
        );
        // LAST wins, like the TS reader: such a file is refused for writing, so it
        // stays on disk and the two must not disagree about what it says.
        assert_eq!(
            frontmatter_line("---\ndescription: first\ndescription: second\n---\nB\n", "description")
                .as_deref(),
            Some("second"),
        );
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
