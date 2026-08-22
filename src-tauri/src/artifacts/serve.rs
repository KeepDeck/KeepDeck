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
        // html export drops the live-refresh script for the SAME reason
        // md renders without it (below) — and here the note is not merely
        // possible but CERTAIN: the export meta-CSP allows inline script
        // yet names no `connect-src`, so it falls back to `default-src
        // 'none'` and the subscription is refused by policy. A refused
        // EventSource fires `error`, and the block's error arm paints the
        // goodbye. Shipping author bytes verbatim therefore guaranteed a
        // "the server went away" banner on a file the reader just saved.
        ArtifactFormat::Html => {
            body.extend_from_slice(strip_live_refresh(&String::from_utf8_lossy(&bytes)).as_bytes())
        }
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

/// The live-refresh block the SERVER installs on every page it serves —
/// the one copy of the contract, owned here: reload on `version`, a
/// visible goodbye on `bye` or `error`. The subscribe URL
/// carries `location.search` so a `?v=`-PINNED tab subscribes pinned
/// too (the pathname drops the query; without it the server-side
/// pinned-immunity never engages from a real pinned tab). The error arm
/// CLOSES the source once — EventSource silently reconnects forever on
/// server death, which is the silent-staleness the goodbye exists to
/// prevent.
/// It opens with a sentinel guard so a page that already carries a copy
/// (published before the server took ownership) ends up with ONE live
/// subscription rather than two.
const LIVE_REFRESH_JS: &str = include_str!("refresh.js");

fn live_refresh_snippet() -> String {
    // `refresh.js` owns pure JavaScript; the server owns the HTML wrapper.
    // The asset's trailing newline is the newline before </script>.
    format!("<script>\n{LIVE_REFRESH_JS}</script>")
}

/// The one line that names a live subscription. Used to RECOGNISE a
/// refresh block, never to decide whether to add one — the serve path
/// injects unconditionally, because this signature is content and the
/// pages KeepDeck publishes are frequently about KeepDeck: a page that
/// merely QUOTES the block in a `<pre>` would read as already-subscribed.
const SUBSCRIPTION_SIGNATURE: &str = "EventSource(location.pathname";

/// Drop every `<script>` element that opens a live subscription.
///
/// EXPORT ONLY, and the asymmetry is the whole licence for cutting at all:
/// here a wrong cut degrades to a page that does not refresh, which is
/// exactly what an exported page should do, while the same cut on the
/// serve path would break a live page. So this recognises by content —
/// tolerated where being wrong is harmless, and refused where it is not.
///
/// Scoped to SCRIPT ELEMENTS on purpose: a page documenting the artifacts
/// feature carries the signature as escaped text inside `<pre>`, which is
/// prose and must survive the round trip untouched.
fn strip_live_refresh(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(open) = rest.find("<script") {
        let after_open = &rest[open..];
        let Some(close) = after_open.find("</script>") else {
            break; // unterminated: nothing to bound, leave the tail as-is
        };
        let element = &after_open[..close + "</script>".len()];
        if element.contains(SUBSCRIPTION_SIGNATURE) {
            out.push_str(&rest[..open]);
        } else {
            out.push_str(&rest[..open + element.len()]);
        }
        rest = &after_open[close + "</script>".len()..];
    }
    out.push_str(rest);
    out
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
    use super::{
        live_refresh_snippet, strip_live_refresh, LIVE_REFRESH_JS, SUBSCRIPTION_SIGNATURE,
    };
    use crate::skills::BUNDLED;

    /// THE EXPORT PIN: an exported page never renders the goodbye.
    ///
    /// The property is user-visible, not structural — a reader who saves a
    /// file must not open it to "This page's server went away". It is
    /// stated as the ABSENCE OF A LIVE SUBSCRIPTION because that is the
    /// only cause: the export meta-CSP permits inline script but names no
    /// `connect-src`, so it falls back to `default-src 'none'`, the
    /// subscription is refused by policy, the refusal fires `error`, and
    /// the error arm paints the note. No subscription, no note.
    #[test]
    fn an_exported_page_never_renders_the_goodbye() {
        let pasted = format!(
            "<html><body><h1>report</h1>\n{}\n</body></html>",
            live_refresh_snippet(),
        );
        let exported = strip_live_refresh(&pasted);
        assert!(
            !exported.contains(SUBSCRIPTION_SIGNATURE),
            "an exported page must carry no live subscription",
        );
        assert!(
            exported.contains("<h1>report</h1>"),
            "the author's own page must survive the cut",
        );
    }

    /// The cut is scoped to SCRIPT ELEMENTS. A page that documents the
    /// artifacts feature quotes the block as prose — escaped, inside
    /// `<pre>` — and that is the corpus this feature publishes most: the
    /// pages about KeepDeck itself. Prose must round-trip untouched.
    #[test]
    fn export_keeps_a_quoted_block_and_unrelated_scripts() {
        let page = format!(
            "<body><pre>&lt;script&gt;{sig}…&lt;/script&gt;</pre>\
             <script>const chart=1;</script>{live}</body>",
            sig = SUBSCRIPTION_SIGNATURE,
            live = live_refresh_snippet(),
        );
        let exported = strip_live_refresh(&page);
        assert!(
            exported.contains("<pre>&lt;script&gt;"),
            "a quoted block is prose and must survive",
        );
        assert!(
            exported.contains("const chart=1;"),
            "an unrelated script must survive",
        );
        assert_eq!(
            exported.matches("<script").count(),
            1,
            "only the subscribing element is cut",
        );
    }


    /// THE INVERTED SOURCE PIN — heir to the byte-pin this replaces.
    ///
    /// The old pin held the skill's fenced example byte-identical to the
    /// asset, because the contract lived in TWO documents and had to be
    /// copied by hand. It does not any more: the server installs the
    /// script, and the skill teaches agents to write none. So the pin
    /// inverts — the skill must contain NO subscription at all.
    ///
    /// Same file, same drift it guards, opposite assertion: the failure it
    /// exists to catch is the teaching CREEPING BACK, which would put a
    /// second subscription on every page that follows it.
    #[test]
    fn the_skill_teaches_no_refresh_script() {
        let taught = BUNDLED
            .iter()
            .find(|skill| skill.name == "artifacts")
            .expect("the artifacts skill ships");
        assert!(
            !taught.content.contains(SUBSCRIPTION_SIGNATURE),
            "the skill must teach no refresh script — the server installs it",
        );
    }
}
