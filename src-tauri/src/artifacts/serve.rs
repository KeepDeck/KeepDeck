//! Body builders for the display server (B6-B7): the shared template,
//! per-format CSP, the index page, and the export pipeline's byte-zero
//! meta injection.

use std::net::TcpStream;
use std::path::Path;

use crate::artifacts::render::escape_html;
use crate::artifacts::store::{read_version_bytes, ArtifactFormat, Manifest, store_meta};

const MIME_HTML: &str = "text/html";

/// The per-artifact serving CSP — PATH-PINNED: the artifact's own events
/// endpoint is the one connectable URL (never `'self'` — artifact A's JS
/// must not reach artifact B's endpoint even with a valid token).
///
/// The endpoint ARRIVES as data, already absolute. This module does not
/// know the origin and must not: url grammar has one home, beside the
/// route that answers it. And the source has to carry that origin — a
/// bare path is not a source-expression, the grammar requires a host, so
/// `connect-src /a/…/events` named nothing and blocked every
/// subscription instead of pinning it.
fn artifact_csp(events: &str) -> String {
    format!(
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src {events}; base-uri 'none'; form-action 'none'"
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
    // The artifact's own events endpoint, absolute — built by the caller,
    // which owns the url grammar.
    events_url: &str,
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
    let csp = artifact_csp(events_url);
    let body: Vec<u8> = {
        let ArtifactFormat::Html = manifest.format;
        {
            let (page, placement) = live_page(&String::from_utf8_lossy(&bytes));
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
    let _ = crate::http::respond_with_body(stream, 200, MIME_HTML, &body, &[
        ("Content-Security-Policy", csp.as_str()),
        // The page is versioned in place and reloads itself on a version
        // event. Nothing here offers a validator, so without this the
        // reload's freshness is a browser heuristic — and a cached copy
        // can paint a page whose server is not answering at all.
        ("Cache-Control", "no-store"),
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
    let _ = crate::http::respond_with_body(stream, 200, MIME_HTML, &body, &[
        ("Content-Disposition", disposition.as_str()),
        // Same reason as the page: no validators anywhere, so a cached
        // export would hand back a version the artifact has moved past.
        ("Cache-Control", "no-store"),
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
        let token = escape_html(&meta.token);
        // One link per version, newest first. `?v=` is the ONLY way a
        // human opens an older version in a browser — agents have
        // artifact_read, readers had nothing, and the route has parsed
        // the pin since day one with no door in the product emitting it.
        // Versions are dense 1..=count (the store's strict shape).
        let versions = (1..=meta.version_count)
            .rev()
            .map(|n| format!("<a href=\"/a/{token}/{slug}?v={n}\">v{n}</a>"))
            .collect::<Vec<_>>()
            .join(" ");
        entries.push_str(&format!(
            "<li><a href=\"/a/{token}/{slug}\">{title}</a> <small>by {author}</small> · <small>{versions}</small> · <a href=\"/a/{token}/{slug}/export\">export</a></li>",
            token = token,
            slug = slug,
            title = escape_html(&meta.title),
            author = escape_html(&meta.last_author),
            versions = versions,
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
    let _ = crate::http::respond_with_body(stream, 200, MIME_HTML, body.as_bytes(), &[
        ("Content-Security-Policy", INDEX_CSP),
        // Refresh here IS the browser reload (zero-JS by design), so a
        // cached copy would defeat the only way this page updates.
        ("Cache-Control", "no-store"),
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

/// The serve-time page transform: cut the author's subscription, install
/// ours. ONE function, so the pin exercises what the server does instead
/// of re-assembling the halves and drifting from it.
///
/// The install is UNCONDITIONAL — never skipped, so every served page
/// subscribes. Detect-and-SKIP was refused and stays refused: the marker
/// is content, these pages are frequently about KeepDeck, and a page
/// quoting the block in a `<pre>` would read as subscribed and never
/// refresh again. Cutting first is what makes the unconditional install
/// safe (script elements only — quoted prose survives), so being wrong
/// costs a page one of its own scripts rather than its refresh.
///
/// Before `</body>` when there is one, appended when there is not: a
/// page too malformed to close its body still gets served and still
/// refreshes, because a display server that refuses to display is a
/// worse failure than a script in an odd place.
fn live_page(html: &str) -> (String, RefreshPlacement) {
    let authored = strip_live_refresh(html);
    let snippet = live_refresh_snippet();
    match authored.rfind("</body>") {
        Some(at) => (
            format!("{}{snippet}{}", &authored[..at], &authored[at..]),
            RefreshPlacement::BeforeBodyClose,
        ),
        None => (format!("{authored}{snippet}"), RefreshPlacement::Appended),
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
/// BOTH PATHS. Export cuts so the reader's saved file never announces a
/// server it cannot reach. Serve cuts so an author's own copy cannot
/// subscribe ALONGSIDE the one we install — the sentinel guard cannot
/// stop it, because a hand-written copy carries no sentinel, and every
/// page published before the server took ownership is exactly that.
///
/// Scoped to SCRIPT ELEMENTS on purpose: a page documenting the artifacts
/// feature carries the signature as escaped text inside `<pre>`, which is
/// prose and must survive the round trip untouched. The residual cost is
/// a page whose own live script merely MENTIONS the signature — it loses
/// that script; a double subscription costs every such page a permanent
/// second stream, so the trade is taken knowingly.
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
    crate::http::respond_with_body(stream, status, mime, body, &[])
}


#[cfg(test)]
mod tests {
    use super::{
        live_page, live_refresh_snippet, strip_live_refresh, RefreshPlacement,
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


    /// The script agents were TAUGHT to paste before the server took
    /// ownership. It carries NO sentinel — the sentinel arrived with the
    /// server's own copy — and this is the shape every legacy page in the
    /// store actually holds.
    const PRE_SENTINEL: &str = "<script>(()=>{\
const es=new EventSource(location.pathname+\"/events\"+location.search);\
es.addEventListener(\"version\",()=>location.reload());})();</script>";

    /// THE BEHAVIOURAL SERVE PIN: what a reader's browser ends up doing.
    ///
    /// Its ancestor built the "legacy" page out of the CURRENT asset
    /// pasted twice — a page shape that has never existed, since a real
    /// legacy copy carries no sentinel. It therefore proved only that the
    /// guard defends against copies of itself, and passed while every
    /// page in the store double-subscribed. The legacy case is built from
    /// the pre-sentinel shape now, and the property is the outcome:
    /// whatever was published, the reader's tab opens ONE stream.
    #[test]
    fn every_served_page_carries_exactly_one_live_subscription() {
        let (plain, placement) = live_page("<html><body><h1>report</h1></body></html>");
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

        let (legacy, _) = live_page(&format!("<html><body>{PRE_SENTINEL}</body></html>"));
        assert_eq!(
            legacy.matches(SUBSCRIPTION_SIGNATURE).count(),
            1,
            "a sentinel-less author copy is CUT, not tolerated: one stream",
        );
        assert!(
            legacy.contains("window.__keepdeckRefresh"),
            "and the surviving subscription is the server's own",
        );
    }

    /// The serve-time cut is scoped like the export one: an author's
    /// unrelated script keeps working, and a quoted block stays prose.
    #[test]
    fn the_serve_cut_spares_unrelated_scripts_and_quoted_prose() {
        let (served, _) = live_page(&format!(
            "<body><pre>&lt;script&gt;{sig}…&lt;/script&gt;</pre>\
             <script>const chart=1;</script>{PRE_SENTINEL}</body>",
            sig = SUBSCRIPTION_SIGNATURE,
        ));
        assert!(served.contains("<pre>&lt;script&gt;"), "quoted prose survives");
        assert!(served.contains("const chart=1;"), "an unrelated script survives");
        assert_eq!(
            served.matches(SUBSCRIPTION_SIGNATURE).count(),
            2,
            "the quoted mention plus exactly one live subscription",
        );
    }

    /// A page too malformed to close its body is still served, and still
    /// refreshes: refusing to display is the worse failure.
    #[test]
    fn a_page_without_a_body_close_is_still_served_subscribed() {
        let (served, placement) = live_page("<h1>fragment</h1>");
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
