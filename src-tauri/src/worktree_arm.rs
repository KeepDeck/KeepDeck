//! Keeping git blind to what KeepDeck plants inside a pane's working
//! directory ([`crate::cwd_arm`]): an anchored line in the owning repo's
//! SHARED `info/exclude`, added when something is planted and removed when
//! nothing of ours needs it any more.

use std::io;
use std::path::{Path, PathBuf};

/// A path to keep git blind to, relative to the armed cwd, matched
/// literally: a name holding `*`, `?` or `[` is that name, not a pattern.
/// `directory` matches it only as a directory (a symlink is a file to git).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Excluded {
    pub(crate) path: String,
    pub(crate) directory: bool,
}

/// The repo an armed cwd's exclude lines go to: its COMMON git dir — two
/// linked worktrees of one repo share it, so two plantings with the same
/// exclusion share ONE line — and the cwd's place below the repo root.
#[derive(Debug, Clone)]
pub(crate) struct ExcludeRepo {
    common_dir: PathBuf,
    below_root: String,
}

impl ExcludeRepo {
    /// The repo owning `armed_root`, or `None` when no ancestor is a git
    /// checkout: a cwd outside any has nowhere to write and is left alone.
    pub(crate) fn of(armed_root: &Path) -> io::Result<Option<Self>> {
        let Some(repo) = keepdeck_git::exclude::owning_repo(armed_root)? else {
            return Ok(None);
        };
        let common_dir = std::fs::canonicalize(&repo.common_dir).unwrap_or(repo.common_dir);
        Ok(Some(Self { common_dir, below_root: repo.below_root }))
    }

    /// `relative`, an entry's path below the armed cwd, as a path below the
    /// root of any worktree of the repo.
    pub(crate) fn below_root(&self, relative: &str) -> PathBuf {
        Path::new(&self.below_root).join(relative)
    }

    /// The line builds before exact exclusion wrote for a planting whose
    /// path began with `segment` — `/<subdir>/<segment>/`, raw, unescaped —
    /// byte for byte what stands in users' exclude files, so it can be found
    /// and taken out again.
    pub(crate) fn legacy_line(&self, segment: &str) -> io::Result<ExcludeLine> {
        let line = if self.below_root.is_empty() {
            format!("/{segment}/")
        } else {
            format!("/{}/{segment}/", self.below_root)
        };
        self.exclude_line(line)
    }

    /// The line keeping git blind to `excluded`: anchored at the armed cwd
    /// (`/<path>` at the repo root, `/<subdir>/<path>` below it), literal
    /// throughout, with a trailing `/` for a directory only.
    pub(crate) fn line(&self, excluded: &Excluded) -> io::Result<ExcludeLine> {
        let path = if self.below_root.is_empty() {
            excluded.path.clone()
        } else {
            format!("{}/{}", self.below_root, excluded.path)
        };
        let suffix = if excluded.directory { "/" } else { "" };
        self.exclude_line(format!("/{}{suffix}", literal(&path)))
    }

    /// `line`, whole as rendered — the repo's folders above the cwd included
    /// — or an error when git could not read it as one line.
    fn exclude_line(&self, line: String) -> io::Result<ExcludeLine> {
        if !hideable(&line) {
            let why = format!("git cannot be told to ignore {line:?}: it holds a line break");
            return Err(io::Error::new(io::ErrorKind::InvalidInput, why));
        }
        Ok(ExcludeLine { common_dir: self.common_dir.clone(), line })
    }
}

/// Whether git could be told to ignore `path` at all: an exclude file is read
/// line by line, so a name holding a line break can never be one pattern.
pub(crate) fn hideable(path: &str) -> bool {
    !path.contains(['\n', '\r'])
}

/// One line of a repo's SHARED `info/exclude` that KeepDeck adds and takes
/// out as its own.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExcludeLine {
    common_dir: PathBuf,
    line: String,
}

impl ExcludeLine {
    /// The common git dir whose exclude file holds it.
    pub(crate) fn common_dir(&self) -> &Path {
        &self.common_dir
    }
}

/// Add `add` and take out `remove` — each line marked as KeepDeck's, the same
/// pattern the user wrote left as theirs — in one read and at most one write
/// of each repo's exclude file (byte-faithful editing lives in
/// `keepdeck_git::exclude`). Answers how many files were written.
pub(crate) fn update(add: &[ExcludeLine], remove: &[ExcludeLine]) -> io::Result<usize> {
    let mut repos: Vec<&Path> = add.iter().chain(remove).map(|l| l.common_dir.as_path()).collect();
    repos.sort();
    repos.dedup();
    fn lines_in<'a>(of: &'a [ExcludeLine], repo: &Path) -> Vec<&'a str> {
        of.iter().filter(|l| l.common_dir == repo).map(|l| l.line.as_str()).collect()
    }
    let mut written = 0;
    for repo in repos {
        written += usize::from(keepdeck_git::exclude::update(repo, &lines_in(add, repo), &lines_in(remove, repo))?);
    }
    Ok(written)
}

/// `path` as a gitignore pattern matching only itself: git's wildcard and
/// escape characters each escaped, and trailing spaces — which git would
/// trim — kept by escaping them too.
fn literal(path: &str) -> String {
    let mut escaped = String::with_capacity(path.len());
    for c in path.chars() {
        if matches!(c, '\\' | '*' | '?' | '[' | ']') {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    let kept = escaped.trim_end_matches(' ');
    let spaces = escaped.len() - kept.len();
    format!("{kept}{}", "\\ ".repeat(spaces))
}

#[cfg(test)]
pub(crate) mod test_support {
    use std::fs;
    use std::path::{Path, PathBuf};

    /// An exclude line as a record would hold it.
    pub(crate) fn exclude_line(common_dir: &str, line: &str) -> super::ExcludeLine {
        super::ExcludeLine { common_dir: common_dir.into(), line: line.into() }
    }

    /// A fake linked-worktree checkout: `main/.git/` (common dir) plus a
    /// worktree whose `.git` FILE points at `main/.git/worktrees/wt` with a
    /// `commondir` back-pointer — the layout `git worktree add` produces,
    /// built by hand so the test needs no git binary.
    pub(crate) fn fake_worktree(base: &Path) -> PathBuf {
        let common = base.join("main").join(".git");
        let gitdir = common.join("worktrees").join("wt");
        fs::create_dir_all(&gitdir).unwrap();
        fs::write(gitdir.join("commondir"), "../..\n").unwrap();
        let wt = base.join("wt");
        fs::create_dir_all(&wt).unwrap();
        fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        wt
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> bool {
        Command::new("git").args(args).current_dir(dir).output().unwrap().status.success()
    }

    /// Whether git, asked for real, ignores `path` (relative to `repo`).
    fn ignored(repo: &Path, path: &str) -> bool {
        git(repo, &["check-ignore", "-q", "--no-index", path])
    }

    fn file(path: &str) -> Excluded {
        Excluded { path: path.into(), directory: false }
    }

    #[test]
    fn a_name_holding_gits_wildcards_is_hidden_as_itself_and_as_nothing_else() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        fs::create_dir_all(&repo).unwrap();
        assert!(git(&repo, &["init", "-q"]));
        let cases = [
            ("skills/review[old]", ["skills/reviewo", "skills/reviewd"]),
            ("skills/a*b", ["skills/axxb", "skills/ab"]),
            ("skills/q?", ["skills/qq", "skills/q"]),
            ("skills/back\\slash", ["skills/backslash", "skills/back/slash"]),
            ("skills/trailing ", ["skills/trailing", "skills/trailing  "]),
        ];
        let at = ExcludeRepo::of(&repo).unwrap().unwrap();
        let lines: Vec<ExcludeLine> = cases.iter().map(|(name, _)| at.line(&file(name)).unwrap()).collect();
        update(&lines, &[]).unwrap();
        for (name, others) in &cases {
            assert!(ignored(&repo, name), "{name:?} itself is hidden");
            for other in others {
                assert!(!ignored(&repo, other), "{other:?} is not hidden by {name:?}");
            }
        }
    }

    #[test]
    fn a_line_break_anywhere_in_the_rendered_path_is_no_line_at_all() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        let cwd = repo.join("pkg\nx");
        fs::create_dir_all(&cwd).unwrap();
        assert!(git(&repo, &["init", "-q"]));
        let at = ExcludeRepo::of(&cwd).unwrap().unwrap();
        let err = at.line(&Excluded { path: ".k".into(), directory: false }).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(at.legacy_line(".k").is_err());
        assert!(!hideable("a\rb") && hideable("a b"));
    }

    #[test]
    fn the_cwds_place_below_the_root_is_literal_too_and_a_directory_is_only_a_directory() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        let cwd = repo.join("pkg[1]");
        fs::create_dir_all(&cwd).unwrap();
        assert!(git(&repo, &["init", "-q"]));
        let line =
            ExcludeRepo::of(&cwd).unwrap().unwrap().line(&Excluded { path: ".k".into(), directory: true }).unwrap();
        assert_eq!(line.line, "/pkg\\[1\\]/.k/");
        update(&[line], &[]).unwrap();
        fs::create_dir_all(cwd.join(".k")).unwrap();
        fs::create_dir_all(repo.join("pkg1/.k")).unwrap();
        assert!(ignored(&repo, "pkg[1]/.k/a"));
        assert!(!ignored(&repo, "pkg1/.k/a"));
    }

    #[test]
    fn a_legacy_line_is_the_raw_text_older_builds_wrote() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        let cwd = repo.join("pkg[1]");
        fs::create_dir_all(&cwd).unwrap();
        fs::create_dir_all(repo.join(".git")).unwrap();
        let at = ExcludeRepo::of(&cwd).unwrap().unwrap();
        assert_eq!(at.legacy_line(".agents").unwrap().line, "/pkg[1]/.agents/");
        assert_eq!(at.below_root(".agents/skills"), Path::new("pkg[1]/.agents/skills"));
    }
}
