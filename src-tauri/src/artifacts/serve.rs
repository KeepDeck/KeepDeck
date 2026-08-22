//! Body builders for the display server (B6-B7): the shared template,
//! per-format CSP, the index page, and the export pipeline's byte-zero
//! meta injection.

use std::io::Write;
use std::net::TcpStream;
use std::path::Path;

use crate::artifacts::render::{escape_html, render_markdown};
use crate::artifacts::store::{read_version_bytes, ArtifactFormat, Manifest, store_meta};

const MIME_HTML: &str = "text/html";

/// The per-artifact serving CSP — format-derived and PATH-PINNED: the
/// artifact's own events endpoint is the one connectable URL (never
/// `'self'` — artifact A's JS must not reach artifact B's endpoint even
/// with a valid token).
fn artifact_csp(token: &str, slug: &str) -> String {
    format!(
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src /a/{token}/{slug}/events; base-uri 'none'; form-action 'none'"
    )
}

const INDEX_CSP: &str =
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

/// Serve one artifact version: bytes VERBATIM for html (the page is the
/// agent's document — no chrome injection), the boring template for md.
pub(super) fn serve_artifact(
    stream: &mut TcpStream,
    root: &Path,
    ws: &str,
    manifest: &Manifest,
    slug: &str,
    version: Option<u64>,
) {
    let n = version.unwrap_or_else(|| manifest.versions.last().map(|v| v.n).unwrap_or(1));
    let Some(bytes) = read_version_bytes(root, ws, slug, manifest, n) else {
        let _ = respond(stream, 404, MIME_HTML, b"version unavailable");
        return;
    };
    let csp = artifact_csp(&manifest.token, slug);
    let body: Vec<u8> = match manifest.format {
        ArtifactFormat::Html => bytes,
        ArtifactFormat::Md => md_page(&manifest.title, &String::from_utf8_lossy(&bytes)).into_bytes(),
    };
    let _ = respond_csp(stream, 200, MIME_HTML, &body, &[
        ("Content-Security-Policy", csp.as_str()),
        ("Referrer-Policy", "no-referrer"),
        ("X-Content-Type-Options", "nosniff"),
    ]);
}

/// The export download: meta-CSP PREPENDED AT BYTE ZERO (CSP governs
/// only content after it — an insert-after-their-head point is bypassable
/// by a crafted page placing its head late; browsers tolerate
/// head-before-doctype).
pub(super) fn serve_export(
    stream: &mut TcpStream,
    root: &Path,
    ws: &str,
    manifest: &Manifest,
    slug: &str,
) {
    let n = manifest.versions.last().map(|v| v.n).unwrap_or(1);
    let Some(bytes) = read_version_bytes(root, ws, slug, manifest, n) else {
        let _ = respond(stream, 404, MIME_HTML, b"version unavailable");
        return;
    };
    let export_meta = EXPORT_META.trim_end_matches('\n');
    let mut body = Vec::with_capacity(bytes.len() + export_meta.len());
    body.extend_from_slice(export_meta.as_bytes());
    match manifest.format {
        ArtifactFormat::Html => body.extend_from_slice(&bytes),
        // md export renders WITHOUT the live-refresh snippet: the
        // session URL is dead by design, and a script pointing at
        // nothing would show a goodbye note on first open.
        ArtifactFormat::Md => body.extend_from_slice(
            md_page_static(&manifest.title, &String::from_utf8_lossy(&bytes)).as_bytes(),
        ),
    }
    let disposition = format!("attachment; filename=\"{slug}.html\"");
    let _ = respond_csp(stream, 200, MIME_HTML, &body, &[
        ("Content-Disposition", disposition.as_str()),
        ("Referrer-Policy", "no-referrer"),
        ("X-Content-Type-Options", "nosniff"),
    ]);
}

/// The workspace index (B7's template, zero-JS): a directory, not a
/// canvas — every interpolation escapes, links to artifact pages and
/// export routes, refresh = browser reload.
pub(super) fn serve_index(stream: &mut TcpStream, root: &Path, ws: &str) {
    let mut entries = String::new();
    let mut any = false;
    for meta in store_meta(root, ws) {
        any = true;
        let slug = escape_html(&meta.id);
        entries.push_str(&format!(
            "<li><a href=\"/a/{token}/{slug}\">{title}</a> <small>{fmt} · v{n} · by {author}</small> · <a href=\"/a/{token}/{slug}/export\">export</a></li>",
            token = escape_html(&meta.token),
            slug = slug,
            title = escape_html(&meta.title),
            fmt = match meta.format { ArtifactFormat::Html => "html", ArtifactFormat::Md => "md" },
            n = meta.version_count,
            author = escape_html(&meta.last_author),
        ));
    }
    if !any {
        entries.push_str("<li><small>nothing published in this workspace yet</small></li>");
    }
    let template = INDEX_PAGE.trim_end_matches('\n');
    let (before, after) = template
        .split_once(INDEX_ENTRIES)
        .expect("index asset has its entries marker");
    let body = format!("{before}{entries}{after}");
    let _ = respond_csp(stream, 200, MIME_HTML, body.as_bytes(), &[
        ("Content-Security-Policy", INDEX_CSP),
        ("Referrer-Policy", "no-referrer"),
        ("X-Content-Type-Options", "nosniff"),
    ]);
}

/// The shared md page template — the same one export renders through.
/// The LIVE-REFRESH snippet rides the template: md artifacts refresh in
/// place exactly like html ones (the template is OURS, the snippet is
/// ours, the page's CSP allows our own inline script — and export omits
/// it, where the URL is dead by design).
fn md_page(title: &str, source: &str) -> String {
    let template = MD_PAGE.trim_end_matches('\n');
    let (before_title, after_title) = template
        .split_once(TITLE_MARKER)
        .expect("md page asset has its title marker");
    let (before_body, after_body) = after_title
        .split_once(BODY_MARKER)
        .expect("md page asset has its body marker");
    let (before_refresh, after_refresh) = after_body
        .split_once(REFRESH_MARKER)
        .expect("md page asset has its refresh marker");
    format!(
        "{before_title}{title}{before_body}{body}{before_refresh}{refresh}{after_refresh}",
        title = escape_html(title),
        body = render_markdown(source),
        refresh = live_refresh_snippet(),
    )
}

/// The template-injected live-refresh block — the SAME contract the
/// skill teaches agents to embed in their html pages verbatim: reload on
/// `version`, a visible goodbye on `bye` or `error`. The subscribe URL
/// carries `location.search` so a `?v=`-PINNED tab subscribes pinned
/// too (the pathname drops the query; without it the server-side
/// pinned-immunity never engages from a real pinned tab). The error arm
/// CLOSES the source once — EventSource silently reconnects forever on
/// server death, which is the silent-staleness the goodbye exists to
/// prevent.
/// The module test pins this source of truth against the bundled skill so
/// neither drifts alone.
const LIVE_REFRESH_JS: &str = include_str!("refresh.js");

fn live_refresh_snippet() -> String {
    // `refresh.js` owns pure JavaScript; the server owns the HTML wrapper.
    // The asset's trailing newline is the newline before </script>.
    format!("<script>\n{LIVE_REFRESH_JS}</script>")
}

/// The EXPORT variant of the md page: same template, NO snippet (the
/// URL is dead outside the session — a live-refresh script pointing at
/// nothing would show a goodbye note on first open).
fn md_page_static(title: &str, source: &str) -> String {
    let template = MD_PAGE_STATIC.trim_end_matches('\n');
    let (before_title, after_title) = template
        .split_once(TITLE_MARKER)
        .expect("static md page asset has its title marker");
    let (before_body, after_body) = after_title
        .split_once(BODY_MARKER)
        .expect("static md page asset has its body marker");
    format!(
        "{before_title}{title}{before_body}{body}{after_body}",
        title = escape_html(title),
        body = render_markdown(source),
    )
}

const EXPORT_META: &str = include_str!("export-meta.html");
const INDEX_PAGE: &str = include_str!("index.html");
const MD_PAGE: &str = include_str!("md-page.html");
const MD_PAGE_STATIC: &str = include_str!("md-page-static.html");
const INDEX_ENTRIES: &str = "<!--KEEPDECK-INDEX-ENTRIES-->";
const TITLE_MARKER: &str = "<!--KEEPDECK-TITLE-->";
const BODY_MARKER: &str = "<!--KEEPDECK-BODY-->";
const REFRESH_MARKER: &str = "<!--KEEPDECK-REFRESH-->";

fn respond(
    stream: &mut TcpStream,
    status: u16,
    mime: &str,
    body: &[u8],
) -> std::io::Result<()> {
    respond_csp(stream, status, mime, body, &[])
}

fn respond_csp(
    stream: &mut TcpStream,
    status: u16,
    mime: &str,
    body: &[u8],
    headers: &[(&str, &str)],
) -> std::io::Result<()> {
    let reason = if status == 200 { "OK" } else { "Error" };
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (name, value) in headers {
        head.push_str(name);
        head.push_str(": ");
        head.push_str(value);
        head.push_str("\r\n");
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::{live_refresh_snippet, LIVE_REFRESH_JS};
    use crate::skills::BUNDLED;

    /// One-shot migration pin: while the JS moves out of an escaped Rust
    /// string, prove the served fragment is byte-identical, including both
    /// wrapper newlines, before the legacy literal is retired.
    #[test]
    fn asset_wrap_matches_legacy_served_fragment() {
        const LEGACY_SERVED_FRAGMENT: &str = r#"<script>
(()=>{const note=()=>{const n=document.createElement("div");
n.setAttribute("style","background:#fff;color:#000;padding:8px;position:fixed;bottom:0;left:0;right:0;z-index:9999");
n.textContent="This page's server went away — republish or reopen from the agent's message.";
document.body.appendChild(n);};
const es=new EventSource(location.pathname+"/events"+location.search);
es.addEventListener("version",()=>location.reload());
es.addEventListener("bye",()=>{es.close();note();});
es.addEventListener("error",()=>{es.close();note();});})();
</script>"#;
        assert_eq!(live_refresh_snippet(), LEGACY_SERVED_FRAGMENT);
    }

    /// Every executable line in the pure-JS asset must match the inner lines
    /// of the skill's fenced example verbatim. The two DOM-detail lines are
    /// deliberately CONTAINS exceptions: the skill's surrounding prose may
    /// frame those lines differently while the executable contract remains
    /// pinned everywhere else.
    #[test]
    fn the_skill_snippet_matches_the_refresh_asset_lines() {
        let taught = BUNDLED
            .iter()
            .find(|skill| skill.name == "artifacts")
            .expect("the artifacts skill ships");
        let js_lines: Vec<&str> = LIVE_REFRESH_JS
            .lines()
            .map(str::trim)
            .filter(|line| {
                !line.is_empty()
                    && !line.contains("textContent")
                    && !line.contains("setAttribute")
            })
            .collect();
        let lines: Vec<&str> = taught.content.lines().collect();
        // Anchored on WHAT the block is, not where it sits: the EventSource
        // line exists only inside the refresh contract, so the fence around
        // it is the example — immune to section moves, renames and future
        // html examples elsewhere in the document. Exactly one such block:
        // a second contract in one document is the second-site drift the
        // byte-contract exists to prevent.
        let mut starts: Vec<usize> = Vec::new();
        for (index, line) in lines.iter().enumerate() {
            if line.contains("EventSource(location.pathname") {
                starts.push(index);
            }
        }
        assert_eq!(
            starts.len(),
            1,
            "the skill must teach exactly one refresh block"
        );
        let contract = starts[0];
        // Any fence form opens the block (```, ```html, ```html + info
        // string) — the boundary is structural, not syntactic, so an
        // innocent fence-style edit cannot fail a byte-pin about refresh.js.
        let start = lines[..contract]
            .iter()
            .rposition(|line| line.trim_start().starts_with("```"))
            .expect("the refresh block sits in a fence");
        let end = lines[start + 1..]
            .iter()
            .position(|line| line.trim() == "```")
            .map(|offset| start + 1 + offset)
            .expect("the refresh example closes its fence");
        // The unambiguity argument ("the nearest opener above the contract
        // is the block's own") holds only while the contract is INSIDE a
        // fence — a signature line in prose with any block above it would
        // pair the wrong fences and accuse refresh.js of a range it never
        // touched. The containment is asserted, not assumed.
        assert!(
            contract > start && contract < end,
            "the refresh contract must sit inside the fence the pin measures"
        );
        let taught_lines: Vec<&str> = lines[start + 1..end]
            .iter()
            .map(|line| line.trim())
            .filter(|line| {
                !line.is_empty()
                    && !line.starts_with("<script>")
                    && !line.starts_with("</script>")
                    && !line.contains("textContent")
                    && !line.contains("setAttribute")
            })
            .collect();
        assert_eq!(js_lines, taught_lines);
    }
}
