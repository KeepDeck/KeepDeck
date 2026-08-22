//! Body builders for the display server (B6-B7): the shared template,
//! per-format CSP, the index page, and the export pipeline's byte-zero
//! meta injection.

use std::io::Write;
use std::net::TcpStream;
use std::path::Path;

use crate::artifacts::render::escape_html;
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

/// Serve one artifact version: the author's document for html, the
/// boring template for md — and BOTH carry the live-refresh script,
/// installed here.
///
/// The html page is still the agent's; the only thing added is the
/// subscription, appended at the end of `<body>` where it cannot
/// displace anything the author wrote. Storage stays untouched: what
/// was published is what is stored, and the script exists only in what
/// is SERVED — which is also what lets a fix to `refresh.js` reach every
/// page ever published, without rewriting a single stored byte.
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
    let body: Vec<u8> = {
        let ArtifactFormat::Html = manifest.format;
        {
            let (page, placement) = with_live_refresh(&String::from_utf8_lossy(&bytes));
            if matches!(placement, RefreshPlacement::Appended) {
                // Served, not refused — but say so: a page that never
                // closes its body is malformed enough that the author
                // probably did not mean it, and the refresh sitting
                // outside the body is the visible consequence.
                log::warn!(
                    "artifacts: {slug:?} has no </body>, refresh appended at the end"
                );
            }
            page.into_bytes()
        }
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
    {
        let ArtifactFormat::Html = manifest.format;
        // Export drops the live-refresh script, and the note it would
        // otherwise paint is not merely possible but CERTAIN: the export
        // meta-CSP allows inline script
        // yet names no `connect-src`, so it falls back to `default-src
        // 'none'` and the subscription is refused by policy. A refused
        // EventSource fires `error`, and the block's error arm paints the
        // goodbye. Shipping author bytes verbatim therefore guaranteed a
        // "the server went away" banner on a file the reader just saved.
        body.extend_from_slice(strip_live_refresh(&String::from_utf8_lossy(&bytes)).as_bytes());
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
            "<li><a href=\"/a/{token}/{slug}\">{title}</a> <small>v{n} · by {author}</small> · <a href=\"/a/{token}/{slug}/export\">export</a></li>",
            token = escape_html(&meta.token),
            slug = slug,
            title = escape_html(&meta.title),
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

/// Put the live-refresh script into an author's html page.
///
/// UNCONDITIONAL, and that is the design rather than an oversight. The
/// obvious alternative — look for a subscription and skip if one is
/// there — cannot work, because the marker is CONTENT and these pages
/// are frequently ABOUT KeepDeck: a page quoting the block in a `<pre>`
/// would read as already subscribed and would never refresh again. The
/// same check would also withhold a fixed script from exactly the pages
/// carrying an old copy. So nothing is detected; the asset's own
/// sentinel guard makes a second copy harmless instead.
///
/// Before `</body>` when there is one, appended when there is not: a
/// page too malformed to close its body still gets served and still
/// refreshes, because a display server that refuses to display is a
/// worse failure than a script in an odd place.
/// Where the script ended up. Returned rather than logged from inside,
/// so the builder stays a pure function of its input and the CALLER —
/// which is the only place that knows WHICH artifact this is — owns the
/// warning. The alternative, re-testing the page for `</body>` at the
/// call site, would be a second site deciding the same thing, free to
/// drift from this one without a test noticing.
pub(super) enum RefreshPlacement {
    BeforeBodyClose,
    Appended,
}

fn with_live_refresh(html: &str) -> (String, RefreshPlacement) {
    let snippet = live_refresh_snippet();
    match html.rfind("</body>") {
        Some(at) => (
            format!("{}{snippet}{}", &html[..at], &html[at..]),
            RefreshPlacement::BeforeBodyClose,
        ),
        None => (format!("{html}{snippet}"), RefreshPlacement::Appended),
    }
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


const EXPORT_META: &str = include_str!("export-meta.html");
const INDEX_PAGE: &str = include_str!("index.html");
const INDEX_ENTRIES: &str = "<!--KEEPDECK-INDEX-ENTRIES-->";

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
        live_refresh_snippet, strip_live_refresh, with_live_refresh, RefreshPlacement,
        SUBSCRIPTION_SIGNATURE,
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


    /// THE BEHAVIOURAL SERVE PIN: what a reader's browser ends up doing.
    ///
    /// Stated as the served page rather than as bytes, because the old
    /// pin's lesson was that pinning bytes across two documents only ever
    /// guarded the copying. There is one document now, so the property
    /// worth holding is the outcome: a page that wrote no script gets
    /// exactly one subscription, and a page that carries a pre-ownership
    /// copy gets exactly one ACTIVE one — two script elements, one
    /// subscriber, which is the guard's whole job.
    #[test]
    fn every_served_page_carries_exactly_one_live_subscription() {
        let (plain, placement) = with_live_refresh("<html><body><h1>report</h1></body></html>");
        assert!(matches!(placement, RefreshPlacement::BeforeBodyClose));
        assert_eq!(
            plain.matches(SUBSCRIPTION_SIGNATURE).count(),
            1,
            "a script-less page must be served subscribed",
        );
        assert!(
            plain.contains(&format!("{}</body>", live_refresh_snippet())),
            "the script belongs at the end of the body, after the author's own",
        );

        let (legacy, _) = with_live_refresh(&format!(
            "<html><body>{}</body></html>",
            live_refresh_snippet(),
        ));
        assert_eq!(
            legacy.matches(SUBSCRIPTION_SIGNATURE).count(),
            2,
            "a pre-ownership page keeps its own copy — storage is untouched",
        );
        assert_eq!(
            legacy.matches("window.__keepdeckRefresh").count(),
            4,
            "and BOTH copies carry the sentinel, so only one subscribes",
        );
    }

    /// A page too malformed to close its body is still served, and still
    /// refreshes: refusing to display is the worse failure.
    #[test]
    fn a_page_without_a_body_close_is_still_served_subscribed() {
        let (served, placement) = with_live_refresh("<h1>fragment</h1>");
        assert!(served.starts_with("<h1>fragment</h1>"));
        assert_eq!(served.matches(SUBSCRIPTION_SIGNATURE).count(), 1);
        // The placement is REPORTED, not merely done: it is what lets the
        // caller name the artifact in its warning without re-deciding.
        assert!(matches!(placement, RefreshPlacement::Appended));
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
