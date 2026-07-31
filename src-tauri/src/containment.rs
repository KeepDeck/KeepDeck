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
/// Doing the containment test on the CANONICAL form is what catches every
/// escape at once — `..` walks, absolute-path smuggling, and a symlink whose
/// real target is outside — because all three resolve to a real location
/// before the `starts_with`. A root that can't be canonicalized (gone, or
/// never existed) simply doesn't authorize anything; if none matches, the path
/// is refused.
pub fn resolve_within(path: &str, roots: &[String], everywhere: bool) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path).map_err(|_| format!("no such path: {path}"))?;
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
