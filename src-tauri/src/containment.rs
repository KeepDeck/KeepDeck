//! Scope containment for plugin services that touch the user's project tree.
//!
//! A capability's scope (`workspace` vs `everywhere`) is resolved by the HOST
//! into a concrete list of allowed roots and passed in with every call; the
//! command's job is to prove the requested path really sits inside one of them.
//! [`resolve_within`] is that proof, shared by every project-facing service
//! backend (`project_fs`, `project_git`) so the escape analysis exists once.

use std::fs;
use std::path::{Path, PathBuf};

/// Expand a leading `~/` to the user's home directory — THE home expansion
/// for every containment-adjacent path (three separate copies drifted once;
/// this is the single one). Lossy on a non-UTF-8 home, documented: every
/// caller ultimately round-trips through UTF-8 command payloads anyway.
pub fn expand_home(path: &str) -> Result<String, String> {
    if let Some(rest) = path.strip_prefix("~/") {
        let home = std::env::var_os("HOME").ok_or("no home directory")?;
        return Ok(format!("{}/{rest}", PathBuf::from(home).to_string_lossy()));
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
    let expanded = expand_home(path)?;
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

    /// The real home, read-only: the tests never write under it, and never
    /// set the variable (a home pin in `lib.rs` forbids that in-tree).
    fn home() -> String {
        std::env::var("HOME").expect("a home directory")
    }

    #[test]
    fn a_home_relative_path_is_expanded_before_the_containment_check() {
        let home = home();
        // Inside its own root: the same directory, spelled two ways.
        let resolved = resolve_within("~/", &[home.clone()], false).expect("home is inside home");
        assert_eq!(resolved, fs::canonicalize(&home).unwrap());

        // Outside a root that is not home: refused as OUTSIDE — the spelling
        // was read as the home directory, not as a folder literally named `~`.
        let elsewhere = std::env::temp_dir().to_string_lossy().into_owned();
        let err = resolve_within("~/", &[elsewhere], false).expect_err("home is not the temp dir");
        assert!(err.contains("outside"), "{err}");
    }

    #[test]
    fn a_missing_path_is_named_as_the_caller_spelled_it() {
        let err = resolve_within("~/no-such-keepdeck-folder-0f3a", &[home()], false)
            .expect_err("nothing there");
        assert!(err.contains("no such path: ~/no-such-keepdeck-folder-0f3a"), "{err}");
    }
}
