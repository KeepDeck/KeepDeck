use std::path::Path;

use crate::cmd::run_git;
use crate::error::GitError;

/// One changed path from `git status --porcelain=v2`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    /// Path relative to the repository root.
    pub path: String,
    /// The pre-rename path, when the index stages a rename/copy.
    pub orig_path: Option<String>,
    /// Index (staged) state — the porcelain v2 `X` code; `'.'` = unchanged.
    pub staged: char,
    /// Working-tree (unstaged) state — the porcelain v2 `Y` code; `'.'` = unchanged.
    pub unstaged: char,
    /// Untracked file (a `?` line).
    pub untracked: bool,
    /// Unmerged path (a `u` line) — a conflict awaiting resolution.
    pub conflicted: bool,
}

/// A working tree's status: the branch header plus every changed path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoStatus {
    /// Current branch, `None` when HEAD is detached.
    pub branch: Option<String>,
    /// Whether HEAD is detached.
    pub detached: bool,
    /// The HEAD commit, `None` on an unborn branch (`(initial)`).
    pub oid: Option<String>,
    /// The upstream branch, when one is configured.
    pub upstream: Option<String>,
    /// Commits ahead of upstream; `None` when no upstream is configured.
    pub ahead: Option<u32>,
    /// Commits behind upstream; `None` when no upstream is configured.
    pub behind: Option<u32>,
    /// Changed paths, in git's own output order.
    pub entries: Vec<StatusEntry>,
}

/// Read the working tree's status at `path`.
///
/// `--no-optional-locks` is load-bearing: without it, `git status` may write a
/// refreshed index (taking `index.lock`), and a status poller would then race
/// the user's — or an agent's — own git commands running in the same worktree.
/// With it, status is a pure read that can never stall anyone.
pub fn status(path: &Path) -> Result<RepoStatus, GitError> {
    let out = run_git(
        path,
        &[
            "--no-optional-locks",
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
        ],
    )?;
    Ok(parse_status(&out))
}

/// Parse `git status --porcelain=v2 --branch -z` output into a [`RepoStatus`].
///
/// Pure: tokens are NUL-terminated records. `# branch.*` headers describe HEAD;
/// `1` = ordinary change, `2` = rename/copy (its OLD path arrives as the NEXT
/// NUL token), `u` = unmerged, `?` = untracked. Paths may contain spaces, so
/// each record is split by field COUNT, never greedily.
pub fn parse_status(porcelain_z: &str) -> RepoStatus {
    let mut st = RepoStatus {
        branch: None,
        detached: false,
        oid: None,
        upstream: None,
        ahead: None,
        behind: None,
        entries: Vec::new(),
    };

    let mut tokens = porcelain_z.split('\0');
    while let Some(token) = tokens.next() {
        if token.is_empty() {
            continue;
        }
        if let Some(header) = token.strip_prefix("# ") {
            parse_header(header, &mut st);
            continue;
        }
        let Some((kind, rest)) = token.split_once(' ') else {
            continue;
        };
        match kind {
            // 1 XY sub mH mI mW hH hI path
            "1" => {
                let fields: Vec<&str> = rest.splitn(8, ' ').collect();
                if let (Some(xy), Some(path)) = (fields.first(), fields.get(7)) {
                    st.entries.push(entry(path, None, xy, false, false));
                }
            }
            // 2 XY sub mH mI mW hH hI Xscore path — then the old path as its own token
            "2" => {
                let fields: Vec<&str> = rest.splitn(9, ' ').collect();
                let orig = tokens.next().filter(|s| !s.is_empty());
                if let (Some(xy), Some(path)) = (fields.first(), fields.get(8)) {
                    st.entries
                        .push(entry(path, orig.map(str::to_string), xy, false, false));
                }
            }
            // u XY sub m1 m2 m3 mW h1 h2 h3 path
            "u" => {
                let fields: Vec<&str> = rest.splitn(10, ' ').collect();
                if let (Some(xy), Some(path)) = (fields.first(), fields.get(9)) {
                    st.entries.push(entry(path, None, xy, false, true));
                }
            }
            "?" => st.entries.push(entry(rest, None, "..", true, false)),
            // "!" (ignored) is never requested; unknown kinds are skipped.
            _ => {}
        }
    }
    st
}

fn entry(
    path: &str,
    orig_path: Option<String>,
    xy: &str,
    untracked: bool,
    conflicted: bool,
) -> StatusEntry {
    let mut codes = xy.chars();
    StatusEntry {
        path: path.to_string(),
        orig_path,
        staged: codes.next().unwrap_or('.'),
        unstaged: codes.next().unwrap_or('.'),
        untracked,
        conflicted,
    }
}

fn parse_header(header: &str, st: &mut RepoStatus) {
    let Some((key, value)) = header.split_once(' ') else {
        return;
    };
    match key {
        "branch.oid" => {
            if value != "(initial)" {
                st.oid = Some(value.to_string());
            }
        }
        "branch.head" => {
            if value == "(detached)" {
                st.detached = true;
            } else {
                st.branch = Some(value.to_string());
            }
        }
        "branch.upstream" => st.upstream = Some(value.to_string()),
        "branch.ab" => {
            for part in value.split(' ') {
                if let Some(n) = part.strip_prefix('+') {
                    st.ahead = n.parse().ok();
                } else if let Some(n) = part.strip_prefix('-') {
                    st.behind = n.parse().ok();
                }
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_headers() {
        let input = "# branch.oid abc123\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0";
        let st = parse_status(input);
        assert_eq!(st.oid.as_deref(), Some("abc123"));
        assert_eq!(st.branch.as_deref(), Some("main"));
        assert!(!st.detached);
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        assert_eq!(st.ahead, Some(2));
        assert_eq!(st.behind, Some(1));
        assert!(st.entries.is_empty());
    }

    #[test]
    fn detached_head_has_no_branch() {
        let st = parse_status("# branch.oid abc123\0# branch.head (detached)\0");
        assert!(st.detached);
        assert_eq!(st.branch, None);
    }

    #[test]
    fn unborn_branch_has_no_oid() {
        let st = parse_status("# branch.oid (initial)\0# branch.head main\0");
        assert_eq!(st.oid, None);
        assert_eq!(st.branch.as_deref(), Some("main"));
    }

    #[test]
    fn parses_ordinary_changes_with_spaces_in_paths() {
        let input = "1 M. N... 100644 100644 100644 aaa bbb src/deep file.ts\01 .M N... 100644 100644 100644 aaa aaa README.md\0";
        let st = parse_status(input);
        assert_eq!(st.entries.len(), 2);

        assert_eq!(st.entries[0].path, "src/deep file.ts");
        assert_eq!(st.entries[0].staged, 'M');
        assert_eq!(st.entries[0].unstaged, '.');

        assert_eq!(st.entries[1].path, "README.md");
        assert_eq!(st.entries[1].staged, '.');
        assert_eq!(st.entries[1].unstaged, 'M');
    }

    #[test]
    fn rename_consumes_the_next_token_as_orig_path() {
        let input = "2 R. N... 100644 100644 100644 aaa aaa R100 new name.ts\0old name.ts\0? scratch.txt\0";
        let st = parse_status(input);
        assert_eq!(st.entries.len(), 2);

        assert_eq!(st.entries[0].path, "new name.ts");
        assert_eq!(st.entries[0].orig_path.as_deref(), Some("old name.ts"));
        assert_eq!(st.entries[0].staged, 'R');

        // The token after the rename's old path is parsed as its own record.
        assert_eq!(st.entries[1].path, "scratch.txt");
        assert!(st.entries[1].untracked);
    }

    #[test]
    fn parses_unmerged_and_untracked() {
        let input =
            "u UU N... 100644 100644 100644 100644 a1 a2 a3 conflicted.ts\0? notes.md\0";
        let st = parse_status(input);
        assert_eq!(st.entries.len(), 2);

        assert!(st.entries[0].conflicted);
        assert_eq!(st.entries[0].path, "conflicted.ts");
        assert_eq!(st.entries[0].staged, 'U');
        assert_eq!(st.entries[0].unstaged, 'U');

        assert!(st.entries[1].untracked);
        assert!(!st.entries[1].conflicted);
        assert_eq!(st.entries[1].staged, '.');
    }

    #[test]
    fn empty_input_is_a_clean_headless_status() {
        let st = parse_status("");
        assert_eq!(st.entries.len(), 0);
        assert_eq!(st.branch, None);
        assert_eq!(st.ahead, None);
    }
}
