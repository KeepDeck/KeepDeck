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
    const EXPORT_META: &str = "<head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:\"></head>";
    let mut body = Vec::with_capacity(bytes.len() + EXPORT_META.len());
    body.extend_from_slice(EXPORT_META.as_bytes());
    match manifest.format {
        ArtifactFormat::Html => body.extend_from_slice(&bytes),
        ArtifactFormat::Md => body.extend_from_slice(
            md_page(&manifest.title, &String::from_utf8_lossy(&bytes)).as_bytes(),
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
    let mut body = String::new();
    body.push_str("<!doctype html><html><head><meta charset=\"utf-8\">");
    body.push_str("<title>Artifacts</title><style>body{font-family:system-ui,sans-serif;margin:2rem;max-width:42rem}li{margin:.4rem 0}small{color:#666}</style></head><body><h1>Artifacts</h1><ul>");
    let mut any = false;
    for meta in store_meta(root, ws) {
        any = true;
        let slug = escape_html(&meta.id);
        body.push_str(&format!(
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
        body.push_str("<li><small>nothing published in this workspace yet</small></li>");
    }
    body.push_str("</ul></body></html>");
    let _ = respond_csp(stream, 200, MIME_HTML, body.as_bytes(), &[
        ("Content-Security-Policy", INDEX_CSP),
        ("Referrer-Policy", "no-referrer"),
        ("X-Content-Type-Options", "nosniff"),
    ]);
}

/// The shared md page template — the same one export renders through.
fn md_page(title: &str, source: &str) -> String {
    let style = "body{font-family:system-ui,sans-serif;margin:2rem;max-width:42rem}pre{background:#f4f4f4;padding:1rem;overflow:auto}";
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>{}</title><style>{}</style></head><body>{}</body></html>",
        escape_html(title),
        style,
        render_markdown(source)
    )
}

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
