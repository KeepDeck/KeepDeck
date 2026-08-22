//! HTML escaping for the surfaces KeepDeck itself renders.
//!
//! What is left of the md renderer: the format went, the escaping did
//! not. The workspace INDEX interpolates user-controlled text — artifact
//! titles, slugs, author labels, tokens — into markup KeepDeck writes,
//! and that page is format-agnostic. Nothing here renders anything; it
//! only makes text safe to put between tags.

/// Escape every text byte (`& < > " '`).
pub(super) fn escape_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            other => out.push(other),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::escape_html;

    /// The escaping used to be proved through the md renderer's own
    /// tests — hostile input in, no markup out. Those went with the
    /// format, and this function did not: it is what stands between an
    /// artifact TITLE and the index page's markup, so it gets a pin of
    /// its own rather than inheriting one from a neighbour.
    #[test]
    fn hostile_text_becomes_text_never_markup() {
        let escaped = escape_html("<script>alert('x')</script>");
        assert!(!escaped.contains('<'), "{escaped}");
        assert!(!escaped.contains('>'), "{escaped}");
        assert_eq!(
            escaped,
            "&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;",
        );
    }

    #[test]
    fn every_dangerous_byte_is_covered_including_the_quotes() {
        // Both quote forms matter: the index interpolates into attribute
        // values as well as text.
        assert_eq!(escape_html("&"), "&amp;");
        assert_eq!(escape_html("\""), "&quot;");
        assert_eq!(escape_html("'"), "&#39;");
    }

    #[test]
    fn ordinary_text_passes_through_unchanged() {
        assert_eq!(escape_html("auth-flow v2 — by peer-1"), "auth-flow v2 — by peer-1");
    }
}
