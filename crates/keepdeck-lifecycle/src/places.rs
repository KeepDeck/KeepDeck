//! A team's place: its number in the workspace, with the folder and branch
//! named after it — `kd-<workspace>-N` and `kd/<workspace>/N`. Places are
//! given and freed by the machine that creates and cleans up teams, one event
//! at a time, so two creations never get one number.

use crate::dir::Dir;
use std::collections::BTreeSet;

/// The prefix of every branch KeepDeck names, so its cleanup never touches
/// the user's own branches.
pub const PREFIX: &str = "kd";

/// One component of a branch name, made fit for git's `check-ref-format`:
/// control characters, whitespace, `/`, `@` and `~^:?*[\` become one `-`;
/// `..` collapses; leading and trailing `-`/`.` and a trailing `.lock` go;
/// never empty (`agent`).
pub fn sanitize_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut prev_dash = false;
    for c in input.chars() {
        let illegal = c.is_control() || c.is_whitespace() || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\' | '/' | '@');
        if illegal {
            if !prev_dash && !out.is_empty() {
                out.push('-');
                prev_dash = true;
            }
        } else {
            out.push(c);
            prev_dash = c == '-';
        }
    }
    while out.contains("..") {
        out = out.replace("..", ".");
    }
    let mut result = out.trim_matches(|c| c == '-' || c == '.').to_string();
    while let Some(stripped) = result.strip_suffix(".lock") {
        result = stripped.trim_end_matches(['-', '.']).to_string();
    }
    if result.is_empty() {
        "agent".to_string()
    } else {
        result
    }
}

/// The branch of place `n` in the workspace named `workspace`.
pub fn branch(workspace: &str, n: u32) -> String {
    format!("{PREFIX}/{}/{n}", sanitize_component(workspace))
}

/// The folder of place `n`: its branch, with `/` as `-`.
pub fn folder(workspace: &str, n: u32) -> String {
    branch(workspace, n).replace('/', "-")
}

/// Where the folder of place `n` goes, in the workspace's worktree base.
pub fn path(base: &Dir, workspace: &str, n: u32) -> Dir {
    Dir::new(&format!("{}/{}", base.as_str(), folder(workspace, n)))
}

/// What already holds a folder or a branch: a team, a ticket, a cleanup not
/// done yet. Disk facts are not here — they come from reading the place.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Held {
    pub paths: BTreeSet<Dir>,
    pub branches: BTreeSet<String>,
}

impl Held {
    /// Whether this folder or this branch is held.
    pub fn holds(&self, path: &Dir, branch: &str) -> bool {
        self.paths.contains(path) || self.branches.contains(branch)
    }
}

/// The first place from `from` whose folder and branch nobody holds. What is
/// on disk there is the next question: a place the disk turns out to hold is
/// skipped by asking again from the number after it.
pub fn first_free(held: &Held, base: &Dir, workspace: &str, from: u32) -> u32 {
    (from.max(1)..).find(|&n| !held.holds(&path(base, workspace, n), &branch(workspace, n))).expect("a free place below u32::MAX")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_place_names_its_branch_and_folder_after_the_workspace_and_its_number() {
        assert_eq!(branch("KeepDeck", 3), "kd/KeepDeck/3");
        assert_eq!(folder("KeepDeck", 3), "kd-KeepDeck-3");
        assert_eq!(path(&Dir::new("/wt/"), "KeepDeck", 3), Dir::new("/wt/kd-KeepDeck-3"));
    }

    #[test]
    fn a_workspace_name_is_made_fit_for_a_branch() {
        assert_eq!(branch("my app", 1), "kd/my-app/1");
        assert_eq!(branch("a..b/c", 2), "kd/a.b-c/2");
        assert_eq!(branch("x.lock", 1), "kd/x/1");
        assert_eq!(branch("@@@", 1), "kd/agent/1", "nothing left: a fixed word, never empty");
        assert_eq!(sanitize_component("--dots.-"), "dots");
        assert_eq!(sanitize_component("we~ird^ref:name"), "we-ird-ref-name", "a run of illegal characters is one dash");
        assert_eq!(sanitize_component("a...b"), "a.b", "one pass of `..` can leave another");
        assert_eq!(sanitize_component("a.lock.lock"), "a", "one strip of `.lock` can leave another");
        assert_eq!(sanitize_component("release-1.2"), "release-1.2", "a dot that is not reserved stays");
        assert_eq!(sanitize_component(""), "agent");
    }

    #[test]
    fn the_first_free_place_skips_a_held_folder_and_a_held_branch() {
        let base = Dir::new("/wt");
        let mut held = Held::default();
        assert_eq!(first_free(&held, &base, "ws", 1), 1);
        held.paths.insert(path(&base, "ws", 1));
        held.branches.insert(branch("ws", 2));
        assert_eq!(first_free(&held, &base, "ws", 1), 3, "1's folder is a team's, 2's branch a ticket's");
        assert_eq!(first_free(&held, &base, "ws", 4), 4, "a place the disk held is skipped by asking past it");
        assert_eq!(first_free(&held, &base, "ws", 0), 3, "numbers start at 1");
    }
}
