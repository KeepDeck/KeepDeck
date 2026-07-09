//! Branch-name helpers — pure string logic, no git calls.

/// The prefix KeepDeck stamps on every branch it creates, so cleanup can scope
/// itself to our branches and never touch the user's own.
pub const DEFAULT_BRANCH_PREFIX: &str = "kd";

/// Sanitize one component of a branch name so it satisfies git's
/// `check-ref-format` rules.
///
/// Maps control chars, whitespace, `/`, `@`, and the forbidden glob/ref chars
/// `~^:?*[\` to a single `-`; collapses `..` (illegal in a ref); strips leading
/// and trailing `-`/`.`; drops a trailing `.lock`; and never returns empty
/// (falls back to `"agent"`). Dots that aren't part of a reserved form are kept.
pub fn sanitize_branch_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut prev_dash = false;
    for c in input.chars() {
        let illegal = c.is_control()
            || c.is_whitespace()
            || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\' | '/' | '@');
        if illegal {
            // Emit at most one separator for a run of illegal chars, and never
            // a leading one.
            if !prev_dash && !out.is_empty() {
                out.push('-');
                prev_dash = true;
            }
        } else {
            out.push(c);
            prev_dash = c == '-';
        }
    }

    // `..` is forbidden anywhere in a ref; collapse repeatedly (one pass can
    // leave a fresh `..` behind, e.g. "a...b").
    while out.contains("..") {
        out = out.replace("..", ".");
    }

    let mut result = out.trim_matches(|c| c == '-' || c == '.').to_string();
    // Strip a trailing `.lock` repeatedly: git rejects any ref ending in
    // `.lock`, and a single pass leaves `a.lock.lock` -> `a.lock`.
    while let Some(stripped) = result.strip_suffix(".lock") {
        result = stripped
            .trim_end_matches(|c| c == '-' || c == '.')
            .to_string();
    }

    if result.is_empty() {
        "agent".to_string()
    } else {
        result
    }
}

/// Build the default per-agent branch name, e.g. `kd/<workspace>/<n>`.
///
/// `prefix` and `n` are trusted (KeepDeck-controlled); only `workspace` is
/// sanitized, since it can carry a user-typed name.
pub fn default_branch(prefix: &str, workspace: &str, n: usize) -> String {
    format!(
        "{}/{}/{}",
        prefix.trim_matches('/'),
        sanitize_branch_component(workspace),
        n
    )
}

/// The cap on KeepDeck's collision-avoidance suffix: base, base-2, … base-999.
pub const WORKTREE_SUFFIX_MAX: u32 = 999;

/// The `n`th collision-avoidance variant of `base` under KeepDeck's scheme:
/// `1` → `base`, `2` → `base-2`, `3` → `base-3`, … A worktree's branch and its
/// directory share this scheme so they stay in step (`kd/x/1` ↔ `kd-x-1`, then
/// `kd/x/1-2` ↔ `kd-x-1-2`). The single source for both the exact-path
/// `free_branch` and the batch create loop.
pub fn suffixed_name(base: &str, n: u32) -> String {
    if n <= 1 {
        base.to_string()
    } else {
        format!("{base}-{n}")
    }
}

/// `branches` with `pin` moved to the front, the rest keeping their order —
/// the base-branch picker leads with the most likely base (the repo's default
/// branch, else the checked-out one) over a plain alphabetical list. A `None`
/// pin, or one naming no listed branch, leaves the order untouched.
pub fn pin_first(mut branches: Vec<String>, pin: Option<&str>) -> Vec<String> {
    if let Some(name) = pin {
        if let Some(position) = branches.iter().position(|b| b == name) {
            let pinned = branches.remove(position);
            branches.insert(0, pinned);
        }
    }
    branches
}

/// Sanitize a full, possibly slash-separated branch name (e.g. a user-typed
/// `feat/login`) component by component, dropping empty segments. Never empty.
pub fn sanitize_branch(input: &str) -> String {
    let joined = input
        .split('/')
        .filter(|segment| !segment.is_empty())
        .map(sanitize_branch_component)
        .collect::<Vec<_>>()
        .join("/");
    if joined.is_empty() {
        "agent".to_string()
    } else {
        joined
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_illegal_chars_with_a_single_dash() {
        assert_eq!(sanitize_branch_component("feat: my thing"), "feat-my-thing");
        assert_eq!(sanitize_branch_component("a//b  c"), "a-b-c");
        assert_eq!(sanitize_branch_component("we~ird^ref:name"), "we-ird-ref-name");
    }

    #[test]
    fn strips_reserved_edges_and_lock_suffix() {
        assert_eq!(sanitize_branch_component("..hidden.."), "hidden");
        assert_eq!(sanitize_branch_component("-trim-"), "trim");
        assert_eq!(sanitize_branch_component("index.lock"), "index");
        assert_eq!(sanitize_branch_component("a.lock.lock"), "a");
    }

    #[test]
    fn collapses_double_dots_to_single() {
        assert_eq!(sanitize_branch_component("a..b...c"), "a.b.c");
    }

    #[test]
    fn keeps_safe_dots() {
        assert_eq!(sanitize_branch_component("release-1.2"), "release-1.2");
    }

    #[test]
    fn never_returns_empty() {
        assert_eq!(sanitize_branch_component(""), "agent");
        assert_eq!(sanitize_branch_component("***"), "agent");
        assert_eq!(sanitize_branch_component("///"), "agent");
    }

    #[test]
    fn default_branch_shapes_the_name() {
        assert_eq!(default_branch("kd", "My Work", 3), "kd/My-Work/3");
        assert_eq!(default_branch("/kd/", "ws", 0), "kd/ws/0");
    }

    #[test]
    fn sanitize_branch_keeps_slashes_but_cleans_components() {
        assert_eq!(sanitize_branch("feat/my login"), "feat/my-login");
        assert_eq!(sanitize_branch("/feat//x/"), "feat/x");
        assert_eq!(sanitize_branch("we:ird/na me"), "we-ird/na-me");
    }

    #[test]
    fn sanitize_branch_never_empty() {
        assert_eq!(sanitize_branch(""), "agent");
        assert_eq!(sanitize_branch("///"), "agent");
    }

    #[test]
    fn pin_first_moves_the_pin_keeping_the_rest_in_order() {
        let list = || vec!["alpha".to_string(), "main".to_string(), "zeta".to_string()];
        assert_eq!(pin_first(list(), Some("main")), ["main", "alpha", "zeta"]);
        // Already first / absent pin / no pin: the order is untouched.
        assert_eq!(pin_first(list(), Some("alpha")), ["alpha", "main", "zeta"]);
        assert_eq!(pin_first(list(), Some("ghost")), ["alpha", "main", "zeta"]);
        assert_eq!(pin_first(list(), None), ["alpha", "main", "zeta"]);
    }

    #[test]
    fn suffixed_name_leaves_the_base_bare_then_appends() {
        // 1 is the base itself; 2+ append the collision suffix — the scheme the
        // branch and its dir share so they stay in step.
        assert_eq!(suffixed_name("kd/x/1", 1), "kd/x/1");
        assert_eq!(suffixed_name("kd/x/1", 2), "kd/x/1-2");
        assert_eq!(suffixed_name("kd-x-1", 3), "kd-x-1-3");
    }
}
