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
    if let Some(stripped) = result.strip_suffix(".lock") {
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
}
