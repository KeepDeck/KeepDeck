//! The md subset renderer (B7): escape-first, markers scanned on the
//! ESCAPED string — the renderer only ever adds tags it wrote itself, so
//! hostile input can produce text, never markup. No links, no images, no
//! HTML passthrough (under `unsafe-inline` a `javascript:` href executes;
//! under `default-src 'none'` an outbound link gains nothing).
//!
//! Subset (exact, nothing else): headings `#`-`####`, paragraphs,
//! `**strong**`, `*em*`, `` `inline code` ``, fenced code blocks
//! (language annotation ignored), unordered `-` / ordered `1.` lists,
//! tables (`|` rows + `---` separator), blockquotes `>`, `---` hr.

/// Escape every text byte first (`& < > " '`); marker scanning happens on
/// the escaped string — markers are escape-invariant.
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

/// Render one md document to an HTML BODY fragment (the template in
/// serve.rs wraps it). The whole subset, one pass, line-oriented with
/// block-run state (paragraph accumulation, fenced code, and CONSECUTIVE
/// table rows wrapping into one `<table>` — bare `<tr>` outside a table
/// element renders as nothing in a browser).
pub(super) fn render_markdown(source: &str) -> String {
    let mut out = String::new();
    let mut paragraph: Vec<String> = Vec::new();
    let mut in_fence = false;
    let mut fence: Vec<String> = Vec::new();
    let mut in_table = false;

    macro_rules! flush_paragraph {
        () => {
            if !paragraph.is_empty() {
                out.push_str("<p>");
                out.push_str(&inline(&paragraph.join(" ")));
                out.push_str("</p>\n");
                paragraph.clear();
            }
        };
    }
    macro_rules! flush_table {
        () => {
            if in_table {
                out.push_str("</table>\n");
                in_table = false;
            }
        };
    }
    macro_rules! close_table {
        () => {
            if in_table {
                out.push_str("</table>\n");
            }
        };
    }

    for raw in source.lines() {
        let line = raw.trim_end_matches('\r');
        if in_fence {
            if line.trim_start().starts_with("```") {
                flush_table!();
                out.push_str("<pre><code>");
                out.push_str(&escape_html(&fence.join("\n")));
                out.push_str("</code></pre>\n");
                fence.clear();
                in_fence = false;
            } else {
                fence.push(line.to_string());
            }
            continue;
        }
        if line.trim_start().starts_with("```") {
            flush_paragraph!();
            flush_table!();
            in_fence = true;
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            flush_paragraph!();
            flush_table!();
            continue;
        }
        // Headings. The payload escapes BEFORE inline(): inline scans
        // markers on ESCAPED text (its contract) — every block path owes
        // its payload the same escape the paragraph path gives its own.
        if let Some(rest) = trimmed.strip_prefix("#### ") {
            flush_paragraph!();
            flush_table!();
            out.push_str("<h4>");
            out.push_str(&inline(&escape_html(rest)));
            out.push_str("</h4>\n");
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("### ") {
            flush_paragraph!();
            flush_table!();
            out.push_str("<h3>");
            out.push_str(&inline(&escape_html(rest)));
            out.push_str("</h3>\n");
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("## ") {
            flush_paragraph!();
            flush_table!();
            out.push_str("<h2>");
            out.push_str(&inline(&escape_html(rest)));
            out.push_str("</h2>\n");
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("# ") {
            flush_paragraph!();
            flush_table!();
            out.push_str("<h1>");
            out.push_str(&inline(&escape_html(rest)));
            out.push_str("</h1>\n");
            continue;
        }
        // hr.
        if trimmed == "---" || trimmed == "***" {
            flush_paragraph!();
            flush_table!();
            out.push_str("<hr/>\n");
            continue;
        }
        // Blockquote.
        if let Some(rest) = trimmed.strip_prefix('>') {
            flush_paragraph!();
            flush_table!();
            let rest = rest.strip_prefix(' ').unwrap_or(rest);
            out.push_str("<blockquote>");
            out.push_str(&inline(&escape_html(rest)));
            out.push_str("</blockquote>\n");
            continue;
        }
        // List items.
        if let Some(rest) = trimmed.strip_prefix("- ") {
            flush_paragraph!();
            flush_table!();
            out.push_str("<ul><li>");
            out.push_str(&inline(&escape_html(rest)));
            out.push_str("</li></ul>\n");
            continue;
        }
        if let Some(rest) = ordered_item(trimmed) {
            flush_paragraph!();
            flush_table!();
            out.push_str("<ol><li>");
            out.push_str(&inline(&escape_html(rest)));
            out.push_str("</li></ol>\n");
            continue;
        }
        // Table row (header/separator/body): consecutive rows share one
        // <table>; the separator row is structure, not content.
        if trimmed.starts_with('|') && trimmed.ends_with('|') && trimmed.len() > 1 {
            flush_paragraph!();
            let cells: Vec<&str> = trimmed[1..trimmed.len() - 1]
                .split('|')
                .map(str::trim)
                .collect();
            if cells.iter().all(|c| c.starts_with('-') && c.ends_with('-') && !c.is_empty()) {
                continue;
            }
            if !in_table {
                out.push_str("<table>");
                in_table = true;
            }
            out.push_str("<tr>");
            for cell in cells {
                out.push_str("<td>");
                out.push_str(&inline(&escape_html(cell)));
                out.push_str("</td>");
            }
            out.push_str("</tr>\n");
            continue;
        }
        // Otherwise: paragraph text.
        flush_table!();
        paragraph.push(escape_html(trimmed));
    }
    flush_paragraph!();
    close_table!();
    if in_fence {
        // Unterminated fence: render what accumulated, escaped.
        out.push_str("<pre><code>");
        out.push_str(&escape_html(&fence.join("\n")));
        out.push_str("</code></pre>\n");
    }
    out
}

/// `1. `-style ordered item.
fn ordered_item(line: &str) -> Option<&str> {
    let dot = line.find(". ")?;
    let head = &line[..dot];
    if !head.is_empty() && head.chars().all(|c| c.is_ascii_digit()) {
        Some(&line[dot + 2..])
    } else {
        None
    }
}

/// Inline constructs on the ESCAPED string: `**strong**`, `*em*`,
/// `` `code` ``.
fn inline(escaped: &str) -> String {
    let mut out = String::with_capacity(escaped.len());
    let chars: Vec<char> = escaped.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '`' {
            if let Some(end) = chars[i + 1..].iter().position(|&x| x == '`') {
                out.push_str("<code>");
                out.extend(&chars[i + 1..i + 1 + end]);
                out.push_str("</code>");
                i += end + 2;
                continue;
            }
        }
        if c == '*' && i + 1 < chars.len() && chars[i + 1] == '*' {
            if let Some(end) = chars[i + 2..].windows(2).position(|w| w[0] == '*' && w[1] == '*') {
                out.push_str("<strong>");
                out.extend(&chars[i + 2..i + 2 + end]);
                out.push_str("</strong>");
                i += end + 4;
                continue;
            }
        }
        if c == '*' && i + 1 < chars.len() && chars[i + 1] != '*' {
            if let Some(end) = chars[i + 1..].iter().position(|&x| x == '*') {
                out.push_str("<em>");
                out.extend(&chars[i + 1..i + 1 + end]);
                out.push_str("</em>");
                i += end + 2;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_subset_renders() {
        let html = render_markdown(
            "# Title\n\nplain **bold** *em* `code`\n\n- item\n\n1. first\n\n> quote\n\n---\n",
        );
        assert!(html.contains("<h1>Title</h1>"));
        assert!(html.contains("<strong>bold</strong>"));
        assert!(html.contains("<em>em</em>"));
        assert!(html.contains("<code>code</code>"));
        assert!(html.contains("<li>item</li>"));
        assert!(html.contains("<li>first</li>"));
        assert!(html.contains("<blockquote>quote</blockquote>"));
        assert!(html.contains("<hr/>"));
    }

    #[test]
    fn fenced_code_is_escaped_verbatim() {
        let html = render_markdown("```js\n<script>alert(1)</script>\n```\n");
        assert!(html.contains("&lt;script&gt;"));
        assert!(!html.contains("<script>alert"));
    }

    #[test]
    fn hostile_input_never_becomes_markup() {
        let html = render_markdown(
            "<script>x</script>\n\n<b>bold?</b>\n\n[link](javascript:alert(1))\n\n<img src=x>\n",
        );
        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("&lt;b&gt;"));
        assert!(html.contains("&lt;img src=x&gt;"));
        // A javascript: URL is TEXT here — no anchor is ever emitted.
        assert!(!html.contains("<a"));
    }

    #[test]
    fn hostile_input_is_escaped_through_every_block_path() {
        // The regression corpus for the 5 paths that once called inline()
        // on RAW payload (headings, blockquote, list, ordered, table
        // cells): markup fed through each must come out escaped.
        let html = render_markdown(concat!(
            "# h1 <script>a</script>\n",
            "## h2 <img src=x onerror=b>\n",
            "### h3 <b>c</b>\n",
            "#### h4 <iframe>d</iframe>\n",
            "> quote <svg onload=e>\n",
            "- item <script>f</script>\n",
            "1. first <script>g</script>\n",
            "| <script>h</script> | cell <b>i</b> |\n",
        ));
        for hostile in ["<script>", "<img", "<iframe", "<svg", "<b>"] {
            assert!(!html.contains(hostile), "raw {hostile} leaked:\n{html}");
        }
        // Every payload survived AS TEXT (escaped), not silently dropped.
        assert!(html.contains("&lt;script&gt;a&lt;/script&gt;"));
        assert!(html.contains("&lt;script&gt;h&lt;/script&gt;"));
    }

    #[test]
    fn tables_render_cells_and_skip_separators() {
        let html = render_markdown("| a | b |\n| --- | --- |\n| 1 | 2 |\n");
        // CONSECUTIVE rows wrap in ONE <table> — bare <tr> outside a
        // table element renders as nothing (D5-2's pin).
        assert!(html.contains("<table>"), "{html}");
        assert!(html.contains("</table>"), "{html}");
        assert_eq!(html.matches("<table>").count(), 1, "one table, {html}");
        assert!(html.contains("<td>a</td>"));
        assert!(html.contains("<td>2</td>"));
        assert!(!html.contains("<td>-</td>"));
    }

    #[test]
    fn unterminated_fence_renders_accumulated() {
        let html = render_markdown("```\nleft open <b>");
        assert!(html.contains("&lt;b&gt;"));
    }

    #[test]
    fn marker_soup_degrades_to_text() {
        let html = render_markdown("*** weird *** stuff **\n");
        // No panic, and no unbalanced tag made it through as markup.
        assert!(html.contains("weird"));
    }

    #[test]
    fn crlf_and_empty_documents() {
        assert_eq!(render_markdown(""), "");
        assert_eq!(render_markdown("\r\n\r\n"), "");
        let html = render_markdown("# h\r\n\r\ntext\r\n");
        assert!(html.contains("<h1>h</h1>"));
    }
}
