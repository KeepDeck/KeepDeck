//! Scope containment for plugin services that touch the user's project tree.
//!
//! A capability's scope (`workspace` vs `everywhere`) is resolved by the HOST
//! into a concrete list of allowed roots and passed in with every call; the
//! command's job is to prove the requested path really sits inside one of them.
//! [`resolve_within`] is that proof, shared by every project-facing service
//! backend (`project_fs`, `project_git`) so the escape analysis exists once.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::{Path, PathBuf};

/// The user's home as the environment names it — the ONE place this module
/// reads the process's environment. The rules below take the home as a
/// value, so a test hands one in and depends on nothing the machine has.
fn home_dir() -> Option<OsString> {
    std::env::var_os("HOME")
}

/// Expand a leading `~/` to the user's home directory — THE home expansion
/// for every containment-adjacent path (three separate copies drifted once;
/// this is the single one). Lossy on a non-UTF-8 home, documented: every
/// caller ultimately round-trips through UTF-8 command payloads anyway.
pub fn expand_home(path: &str) -> Result<String, String> {
    expand_home_from(path, home_dir().as_deref())
}

/// [`expand_home`] against a given home — the rule itself.
pub fn expand_home_from(path: &str, home: Option<&OsStr>) -> Result<String, String> {
    if let Some(rest) = path.strip_prefix("~/") {
        let home = home.ok_or("no home directory")?;
        return Ok(format!("{}/{rest}", home.to_string_lossy()));
    }
    Ok(path.to_string())
}

/// A root that bounds nothing: the filesystem root, or the user's whole
/// home. The manifest guard rejects the literal spellings ("/", "~/"), but a
/// spelling like "~/../.." canonicalizes to the same place, and no denylist
/// of spellings can enumerate those — so the PROOF refuses such a root as
/// authority, on the canonical form it already computes. This is the
/// semantic half of the same rule; the parse guard remains the loud,
/// author-facing half.
pub fn is_unbounded_root(root: &Path) -> bool {
    if root == Path::new("/") {
        return true;
    }
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        let home = fs::canonicalize(&home).unwrap_or(home);
        if root == home {
            return true;
        }
    }
    false
}

/// Canonicalize `path` and require the result to sit inside one of `roots`
/// (each canonicalized too), unless `everywhere` waives the check. Returns the
/// canonical path on success, or a human reason on rejection.
///
/// A leading `~/` is expanded first ([`expand_home`]), HERE rather than by
/// each caller: the fs backend expanded it and the git backend did not, so
/// the "identical scope contract" the two promise held for one spelling of
/// a path and not the other. Every backend that resolves through this gets
/// the same reading of the same string.
///
/// Doing the containment test on the CANONICAL form is what catches every
/// escape at once — `..` walks, absolute-path smuggling, and a symlink whose
/// real target is outside — because all three resolve to a real location
/// before the `starts_with`. A root that can't be canonicalized (gone, or
/// never existed) simply doesn't authorize anything; if none matches, the path
/// is refused.
pub fn resolve_within(path: &str, roots: &[String], everywhere: bool) -> Result<PathBuf, String> {
    resolve_within_from(path, roots, everywhere, home_dir().as_deref())
}

/// [`resolve_within`] against a given home — the proof itself.
pub fn resolve_within_from(
    path: &str,
    roots: &[String],
    everywhere: bool,
    home: Option<&OsStr>,
) -> Result<PathBuf, String> {
    let expanded = expand_home_from(path, home)?;
    let canonical = fs::canonicalize(&expanded).map_err(|_| format!("no such path: {path}"))?;
    if everywhere {
        return Ok(canonical);
    }
    let contained = roots
        .iter()
        .filter_map(|root| fs::canonicalize(root).ok())
        .any(|root| canonical.starts_with(&root));
    if contained {
        Ok(canonical)
    } else {
        Err(format!("path is outside the allowed workspace roots: {path}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand of its own: a fabricated home and a second directory beside
    /// it, both made here and now. Nothing is read from the machine — not
    /// its HOME, not its git, not where its temp directory happens to sit —
    /// and nothing is set in the process's environment (a home pin in
    /// `lib.rs` forbids that in-tree, and the rules take the home as a
    /// value for exactly this reason).
    struct Stand {
        root: PathBuf,
        home: PathBuf,
        elsewhere: PathBuf,
    }

    impl Stand {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "kd-containment-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let home = root.join("home");
            let elsewhere = root.join("elsewhere");
            fs::create_dir_all(&home).unwrap();
            fs::create_dir_all(&elsewhere).unwrap();
            Self { root, home, elsewhere }
        }

        fn home(&self) -> Option<&OsStr> {
            Some(self.home.as_os_str())
        }

        fn root_of(&self, dir: &Path) -> Vec<String> {
            vec![dir.to_string_lossy().into_owned()]
        }
    }

    impl Drop for Stand {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).ok();
        }
    }

    #[test]
    fn a_home_relative_path_is_expanded_before_the_containment_check() {
        let stand = Stand::new();
        // Inside its own root: the same directory, spelled two ways.
        let resolved = resolve_within_from("~/", &stand.root_of(&stand.home), false, stand.home())
            .expect("home is inside home");
        assert_eq!(resolved, fs::canonicalize(&stand.home).unwrap());

        // Outside a root that is not home: refused as OUTSIDE — the spelling
        // was read as the home directory, not as a folder literally named `~`.
        let err = resolve_within_from("~/", &stand.root_of(&stand.elsewhere), false, stand.home())
            .expect_err("home is not the other directory");
        assert!(err.contains("outside"), "{err}");
    }

    #[test]
    fn a_missing_path_is_named_as_the_caller_spelled_it() {
        let stand = Stand::new();
        let err = resolve_within_from(
            "~/no-such-folder",
            &stand.root_of(&stand.home),
            false,
            stand.home(),
        )
        .expect_err("nothing there");
        assert!(err.contains("no such path: ~/no-such-folder"), "{err}");
    }

    #[test]
    fn without_a_home_a_home_relative_path_is_refused_by_name() {
        let stand = Stand::new();
        let err = resolve_within_from("~/x", &stand.root_of(&stand.home), false, None)
            .expect_err("no home to expand against");
        assert!(err.contains("no home directory"), "{err}");
    }
}
