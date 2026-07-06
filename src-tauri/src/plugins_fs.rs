//! Rust side of the EXTERNAL plugin tier's file serving.
//!
//! Installed external plugins live at `<config_dir>/plugins/<folder>/`
//! (`config_dir` per `crate::paths::keepdeck_home`) — one `manifest.json`
//! plus whatever bundle files the plugin ships. The FOLDER NAME is cosmetic
//! and user-chosen; the manifest's `id` is the plugin's real identity, so
//! every lookup here goes id -> folder by re-scanning and matching, never
//! the other way around.
//!
//! Two things live in this module:
//!
//! - [`plugins_scan`] / [`plugins_resolve_dir`]: commands the TS loader uses
//!   to build its own id -> folder map. Manifests are read RAW — this module
//!   checks only that the bytes are valid UTF-8 JSON; schema validation is
//!   `readManifest`'s job on the TS side (`packages/plugin-api`), matching
//!   how the deck's own persistence keeps schema knowledge next to the model
//!   it mirrors.
//! - the `kdplugin://<plugin-id>/<path>` URI scheme ([`handle_request`]):
//!   every installed plugin is served under its OWN host, so two plugins are
//!   two origins and the browser's same-origin policy is the isolation
//!   primitive (see `src/plugins/external/url.ts`, the TS source of the
//!   scheme name). [`handle_request`] takes the plugins root and window
//!   origin as plain parameters rather than reading Tauri state itself, so
//!   it's unit-testable without a running app; `lib.rs`'s registration binds
//!   the real root and computes the origin from the requesting webview.
//!
//! No caching: both the scan-based commands and the protocol handler re-scan
//! the plugins root on every call. Plugin counts are small (human-installed,
//! one at a time) and this keeps "just installed a plugin" work without a
//! restart — a `OnceLock` cache would need invalidation machinery for a
//! problem that isn't there yet.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::utils::mime_type::MimeType;
use tauri::{AppHandle, Manager as _, Runtime, Url};

/// The external tier's URI scheme. Must match `EXTERNAL_PLUGIN_SCHEME` in
/// `src/plugins/external/url.ts` — this is the single Rust source of the
/// literal, mirrored there.
pub const EXTERNAL_PLUGIN_SCHEME: &str = "kdplugin";

/// One installed plugin as read off disk, before any validation: the folder
/// that carries it, plus its manifest's raw bytes. TS needs both — the
/// folder to resolve `kdplugin://` URLs, the raw JSON to run its own
/// `readManifest`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPluginRecord {
    pub dir_name: String,
    pub manifest_json: String,
}

/// `<config_dir>/plugins`. `None` only in the degenerate no-`HOME`/no-`XDG`
/// environments `keepdeck_home` itself documents; every caller here treats
/// that exactly like an empty (or missing) plugins folder, never as an
/// error — there's nothing to report beyond "no plugins". `pub(crate)` so
/// `lib.rs`'s protocol registration can pass the same root into
/// [`handle_request`].
pub(crate) fn plugins_root() -> Option<PathBuf> {
    crate::paths::keepdeck_home().map(|home| home.join("plugins"))
}

/// List every installed plugin. A missing plugins folder (first run, or no
/// config dir at all) is an empty list, not an error. Sorted by folder name
/// for a deterministic, reproducible order — the same order [`resolve`]'s
/// first-wins duplicate-id rule relies on.
#[tauri::command(async)]
pub fn plugins_scan() -> Vec<InstalledPluginRecord> {
    plugins_root().map(|root| scan(&root)).unwrap_or_default()
}

/// The folder currently providing plugin `id`, or `None` if no installed
/// plugin declares it. Re-scans and returns the first match in sorted
/// order — mirroring the host's first-wins rule when two folders' manifests
/// claim the same id.
#[tauri::command(async)]
pub fn plugins_resolve_dir(id: String) -> Option<String> {
    let root = plugins_root()?;
    resolve(&root, &id).map(|record| record.dir_name)
}

/// Scan `<root>/*/manifest.json`. A folder whose manifest is missing, not
/// UTF-8, or not well-formed JSON is skipped with a `log::warn!` naming the
/// folder — one bad install must never break every other plugin's listing.
fn scan(root: &Path) -> Vec<InstalledPluginRecord> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };

    let mut dirs: Vec<(String, PathBuf)> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter_map(|path| Some((path.file_name()?.to_string_lossy().into_owned(), path)))
        .collect();
    dirs.sort_by(|a, b| a.0.cmp(&b.0));

    dirs.into_iter()
        .filter_map(|(dir_name, dir)| {
            let raw = match fs::read_to_string(dir.join("manifest.json")) {
                Ok(raw) => raw,
                Err(e) => {
                    log::warn!("plugins scan: {dir_name}: manifest unreadable ({e})");
                    return None;
                }
            };
            if let Err(e) = serde_json::from_str::<serde_json::Value>(&raw) {
                log::warn!("plugins scan: {dir_name}: manifest is not valid JSON ({e})");
                return None;
            }
            Some(InstalledPluginRecord {
                dir_name,
                manifest_json: raw,
            })
        })
        .collect()
}

/// The record whose manifest `id` matches, first in `scan`'s sorted order.
fn resolve(root: &Path, id: &str) -> Option<InstalledPluginRecord> {
    scan(root)
        .into_iter()
        .find(|record| manifest_id(&record.manifest_json).as_deref() == Some(id))
}

/// Pull just `id` out of a manifest, as loosely as possible — anything that
/// isn't a JSON object with a string `id` simply never matches. Full
/// validation is `readManifest`'s job on the TS side.
fn manifest_id(manifest_json: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(manifest_json)
        .ok()?
        .get("id")?
        .as_str()
        .map(str::to_string)
}

/// Where an untrusted URL path resolves to under `root`, once symlinks and
/// `.`/`..` are actually resolved on disk.
enum Lookup {
    Found(PathBuf),
    NotFound,
    /// Canonicalized fine, but landed outside `root`.
    Escaped,
}

/// Canonicalize `root.join(relative)`, then check the result is still under
/// `root`'s own canonical form — the Zed `writeable_path_from_extension`
/// model. Doing the containment check on the CANONICAL form, after the
/// join, is what catches every escape at once:
///
/// - `../../etc/passwd` walks out through `..` segments;
/// - an absolute string like `/etc/passwd` exploits `Path::join` silently
///   REPLACING the base entirely when the joined path is itself absolute (a
///   classic footgun) — this check still catches it, because it runs on the
///   joined RESULT, not the input string;
/// - a symlink inside `root` pointing outside resolves to its real target.
///
/// `NotFound` covers both "genuinely absent" and "an escape attempt at a
/// path that happens not to exist" — canonicalize can't tell those apart,
/// and an attacker can't either from a 404, which is the point: only an
/// escape that lands on something real earns the sharper 403.
fn safe_lookup(root: &Path, relative: &str) -> Lookup {
    let Ok(canonical_root) = fs::canonicalize(root) else {
        return Lookup::NotFound;
    };
    let Ok(canonical) = fs::canonicalize(root.join(relative)) else {
        return Lookup::NotFound;
    };
    if canonical.starts_with(&canonical_root) {
        Lookup::Found(canonical)
    } else {
        Lookup::Escaped
    }
}

/// Handle one `kdplugin://<plugin-id>/<path>` request. Pure and synchronous
/// so it's unit-testable without a running Tauri app; `lib.rs`'s
/// registration supplies the real plugins root (`None` when there's no
/// config dir at all) and a `window_origin` computed from the requesting
/// webview via [`window_origin`].
///
/// Status codes: 400 for a host-less/empty-host URL (malformed), 404 for no
/// such plugin or no such file, 403 for a path that escapes the plugin's own
/// folder (see [`safe_lookup`]), 200 otherwise. Every response — including
/// the error ones — carries `Access-Control-Allow-Origin`, matching how
/// `crates/tauri`'s own "asset" protocol scopes itself to the window it
/// serves rather than a blanket `*`.
pub fn handle_request(
    plugins_root: Option<&Path>,
    window_origin: &str,
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let Some(plugins_root) = plugins_root else {
        return respond(window_origin, StatusCode::NOT_FOUND, None, None, Vec::new());
    };

    let Some(host) = request.uri().host().filter(|h| !h.is_empty()) else {
        return respond(window_origin, StatusCode::BAD_REQUEST, None, None, Vec::new());
    };

    let Some(record) = resolve(plugins_root, host) else {
        return respond(window_origin, StatusCode::NOT_FOUND, None, None, Vec::new());
    };

    let relative = request.uri().path().trim_start_matches('/');
    let folder = plugins_root.join(&record.dir_name);

    let canonical = match safe_lookup(&folder, relative) {
        Lookup::Found(path) => path,
        Lookup::NotFound => {
            return respond(window_origin, StatusCode::NOT_FOUND, None, None, Vec::new())
        }
        Lookup::Escaped => {
            log::warn!("kdplugin: refused a path escaping {host}'s folder: {relative}");
            return respond(window_origin, StatusCode::FORBIDDEN, None, None, Vec::new());
        }
    };

    let Ok(body) = fs::read(&canonical) else {
        return respond(window_origin, StatusCode::NOT_FOUND, None, None, Vec::new());
    };

    let content_type = content_type_for(relative);
    let csp = relative.ends_with(".html").then(|| csp_for(&record.manifest_json));

    respond(
        window_origin,
        StatusCode::OK,
        csp.as_deref(),
        Some(&content_type),
        body,
    )
}

/// Build one response, always attaching the CORS header — the one thing
/// every branch of [`handle_request`] must do, success or failure alike.
fn respond(
    origin: &str,
    status: StatusCode,
    csp: Option<&str>,
    content_type: Option<&str>,
    body: Vec<u8>,
) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    if let Some(content_type) = content_type {
        builder = builder.header(header::CONTENT_TYPE, content_type);
    }
    if let Some(csp) = csp {
        builder = builder.header(header::CONTENT_SECURITY_POLICY, csp);
    }
    builder.body(body).expect("response has a valid header set")
}

/// Content-Type from the file extension — the same mapping
/// `crates/tauri`'s own asset protocol serves the app's own bundle with
/// (`.js`/`.mjs` -> `text/javascript` matters: a plugin's ES module script
/// won't execute under the wrong MIME type in a strict browser context).
fn content_type_for(relative: &str) -> String {
    MimeType::parse_from_uri(relative).to_string()
}

/// The CSP for an `.html` response — the Figma `networkAccess` model: the
/// plugin realm's network reach is exactly what its manifest declared, no
/// more. `connect-src` lists the manifest's `net` capability domains as both
/// schemes (manifests declare bare hostnames, not scheme-qualified ones) —
/// plus `'self'` — or nothing beyond `'self'` when the plugin declares no
/// `net` capability at all.
fn csp_for(manifest_json: &str) -> String {
    let mut connect_src = String::from("'self'");
    for domain in net_domains(manifest_json) {
        connect_src.push_str(&format!(" https://{domain} http://{domain}"));
    }
    format!(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
         connect-src {connect_src}; img-src 'self' data:"
    )
}

/// Every domain listed under a `{"kind":"net","domains":[...]}` capability
/// in the manifest's `capabilities` array. Unknown capability kinds, and any
/// other manifest malformation, are silently ignored HERE — this is a
/// best-effort allowlist for a header, not validation; `readManifest` on the
/// TS side is what actually enforces the manifest is well-formed.
fn net_domains(manifest_json: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(manifest_json) else {
        return Vec::new();
    };
    let Some(capabilities) = value.get("capabilities").and_then(|c| c.as_array()) else {
        return Vec::new();
    };
    capabilities
        .iter()
        .filter(|cap| cap.get("kind").and_then(|k| k.as_str()) == Some("net"))
        .filter_map(|cap| cap.get("domains").and_then(|d| d.as_array()))
        .flatten()
        .filter_map(|d| d.as_str().map(str::to_string))
        .collect()
}

/// The requesting webview's current origin (`scheme://host[:port]`), used as
/// [`handle_request`]'s `Access-Control-Allow-Origin`. Computed fresh per
/// request (a webview can navigate) from the live `Webview`'s URL via the
/// stable `get_webview_window` (the singular `get_webview` needs the
/// `unstable` Cargo feature, which this crate doesn't enable). Falls back to
/// `"null"` — a legal, fail-closed `Origin`/ACAO value — when the webview
/// can't be found (shouldn't happen: the request came FROM it) or its URL
/// has no host (a `data:`/`about:` page, which never requests plugin
/// files in practice).
pub fn window_origin<R: Runtime>(app_handle: &AppHandle<R>, webview_label: &str) -> String {
    app_handle
        .get_webview_window(webview_label)
        .and_then(|webview| webview.url().ok())
        .and_then(|url| origin_of(&url))
        .unwrap_or_else(|| "null".to_string())
}

/// `scheme://host[:port]` for `url`, or `None` if it has no host (e.g. a
/// `data:` URL). Hand-built rather than via `Url::origin()` — that method
/// returns an OPAQUE origin (serializing to the literal string `"null"`) for
/// schemes the WHATWG spec doesn't special-case, which includes bespoke
/// schemes like `tauri:`/`kdplugin:`; reading scheme/host/port straight off
/// the URL avoids that trap.
fn origin_of(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// A unique temp plugins-root per test (std-only; no tempfile dependency).
    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!(
            "kd-plugins-fs-test-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn manifest(id: &str) -> String {
        format!(r#"{{"id":"{id}","name":"n","version":"0.0.1","minApiVersion":"0.0.1","capabilities":[]}}"#)
    }

    // ---- scan ----

    #[test]
    fn missing_plugins_dir_scans_empty() {
        assert_eq!(scan(&temp_root()), Vec::new());
    }

    #[test]
    fn scans_two_plugins_sorted_by_folder_name() {
        let root = temp_root();
        write(&root.join("zeta/manifest.json"), &manifest("zeta.plugin"));
        write(&root.join("alpha/manifest.json"), &manifest("alpha.plugin"));

        let found = scan(&root);

        assert_eq!(found.len(), 2);
        assert_eq!(found[0].dir_name, "alpha");
        assert_eq!(found[1].dir_name, "zeta");
    }

    #[test]
    fn broken_json_manifest_is_skipped_not_fatal() {
        let root = temp_root();
        write(&root.join("broken/manifest.json"), "not json at all");
        write(&root.join("good/manifest.json"), &manifest("good.plugin"));

        let found = scan(&root);

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].dir_name, "good");
    }

    #[test]
    fn folder_without_a_manifest_file_is_skipped() {
        let root = temp_root();
        fs::create_dir_all(root.join("empty")).unwrap();
        write(&root.join("good/manifest.json"), &manifest("good.plugin"));

        let found = scan(&root);

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].dir_name, "good");
    }

    #[test]
    fn manifest_raw_bytes_are_preserved_verbatim() {
        let root = temp_root();
        let raw = manifest("verbatim.plugin");
        write(&root.join("only/manifest.json"), &raw);

        let found = scan(&root);

        assert_eq!(found[0].manifest_json, raw);
    }

    // ---- resolve (id -> folder) ----

    #[test]
    fn resolve_finds_the_folder_by_manifest_id_not_folder_name() {
        let root = temp_root();
        write(&root.join("weird-folder-name/manifest.json"), &manifest("real.id"));

        assert_eq!(
            resolve(&root, "real.id").map(|r| r.dir_name),
            Some("weird-folder-name".to_string())
        );
    }

    #[test]
    fn resolve_is_none_for_an_unknown_id() {
        let root = temp_root();
        write(&root.join("a/manifest.json"), &manifest("a.plugin"));
        assert_eq!(resolve(&root, "nope").map(|r| r.dir_name), None);
    }

    #[test]
    fn duplicate_manifest_id_resolves_first_wins_by_folder_sort() {
        let root = temp_root();
        // "alpha" sorts before "zeta"; both manifests declare the same id.
        write(&root.join("zeta/manifest.json"), &manifest("dup.id"));
        write(&root.join("alpha/manifest.json"), &manifest("dup.id"));

        assert_eq!(
            resolve(&root, "dup.id").map(|r| r.dir_name),
            Some("alpha".to_string())
        );
    }

    #[test]
    fn resolve_is_none_when_the_plugins_root_folder_does_not_exist() {
        // `plugins_resolve_dir` (the tauri command) composes `plugins_root()`
        // — which reads the real environment — with `resolve`; this covers
        // `resolve`'s half directly against a root that was never created.
        assert_eq!(resolve(&temp_root(), "anything"), None);
    }

    // ---- traversal guard (safe_lookup) ----

    #[test]
    fn safe_lookup_serves_a_legit_nested_path() {
        let root = temp_root();
        write(&root.join("plugin/assets/logo.png"), "pixels");

        match safe_lookup(&root.join("plugin"), "assets/logo.png") {
            Lookup::Found(path) => {
                assert_eq!(fs::read_to_string(path).unwrap(), "pixels");
            }
            _ => panic!("expected a legit nested path to be found"),
        }
    }

    #[test]
    fn safe_lookup_refuses_dotdot_traversal() {
        let root = temp_root();
        write(&root.join("secret.txt"), "outside");
        write(&root.join("plugin/index.html"), "<html></html>");

        assert!(matches!(
            safe_lookup(&root.join("plugin"), "../secret.txt"),
            Lookup::Escaped
        ));
    }

    #[test]
    fn safe_lookup_refuses_absolute_path_smuggling() {
        let root = temp_root();
        write(&root.join("secret.txt"), "outside");
        fs::create_dir_all(root.join("plugin")).unwrap();

        // `Path::join` silently REPLACES the base with an absolute joined
        // path — the guard must still catch the escape after that join.
        let absolute = root.join("secret.txt");
        assert!(absolute.is_absolute());
        assert!(matches!(
            safe_lookup(&root.join("plugin"), absolute.to_str().unwrap()),
            Lookup::Escaped
        ));
    }

    #[test]
    #[cfg(unix)]
    fn safe_lookup_refuses_a_symlink_pointing_outside() {
        let root = temp_root();
        write(&root.join("secret.txt"), "outside");
        fs::create_dir_all(root.join("plugin")).unwrap();
        std::os::unix::fs::symlink(root.join("secret.txt"), root.join("plugin/escape")).unwrap();

        assert!(matches!(
            safe_lookup(&root.join("plugin"), "escape"),
            Lookup::Escaped
        ));
    }

    #[test]
    fn safe_lookup_is_not_found_for_a_missing_file() {
        let root = temp_root();
        fs::create_dir_all(root.join("plugin")).unwrap();
        assert!(matches!(
            safe_lookup(&root.join("plugin"), "nope.txt"),
            Lookup::NotFound
        ));
    }

    #[test]
    fn safe_lookup_is_not_found_when_the_plugin_folder_itself_is_gone() {
        let root = temp_root();
        assert!(matches!(
            safe_lookup(&root.join("never-existed"), "anything"),
            Lookup::NotFound
        ));
    }

    // ---- the full request handler ----

    fn get(uri: &str) -> Request<Vec<u8>> {
        Request::builder().uri(uri).body(Vec::new()).unwrap()
    }

    #[test]
    fn handle_request_serves_a_legit_file_with_cors_and_content_type() {
        let root = temp_root();
        write(&root.join("demo/manifest.json"), &manifest("demo.plugin"));
        write(&root.join("demo/index.js"), "console.log(1)");

        let resp = handle_request(
            Some(&root),
            "tauri://localhost",
            &get("kdplugin://demo.plugin/index.js"),
        );

        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
            "tauri://localhost"
        );
        assert_eq!(resp.headers().get(header::CONTENT_TYPE).unwrap(), "text/javascript");
        assert_eq!(resp.body(), b"console.log(1)");
    }

    #[test]
    fn handle_request_attaches_csp_only_for_html() {
        let root = temp_root();
        write(
            &root.join("demo/manifest.json"),
            r#"{"id":"demo.plugin","name":"n","version":"0.0.1","minApiVersion":"0.0.1",
                "capabilities":[{"kind":"net","domains":["api.example.com"]}]}"#,
        );
        write(&root.join("demo/index.html"), "<html></html>");
        write(&root.join("demo/index.js"), "1");

        let html = handle_request(
            Some(&root),
            "tauri://localhost",
            &get("kdplugin://demo.plugin/index.html"),
        );
        let js = handle_request(
            Some(&root),
            "tauri://localhost",
            &get("kdplugin://demo.plugin/index.js"),
        );

        let csp = html
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(csp.contains("connect-src 'self' https://api.example.com http://api.example.com"));
        assert!(js.headers().get(header::CONTENT_SECURITY_POLICY).is_none());
    }

    #[test]
    fn handle_request_400s_on_a_hostless_url() {
        let root = temp_root();
        // `http::Uri` refuses to parse most empty-authority forms
        // (`kdplugin:///path`, `kdplugin:/path`) as invalid outright — those
        // never reach a handler at all. `kdplugin://:1/path` is the form it
        // DOES accept with a genuinely empty host (an empty-string host,
        // port 1), which is the malformed-host case our guard must catch.
        let resp = handle_request(Some(&root), "tauri://localhost", &get("kdplugin://:1/path"));
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn handle_request_404s_for_an_unknown_plugin() {
        let root = temp_root();
        let resp = handle_request(
            Some(&root),
            "tauri://localhost",
            &get("kdplugin://nobody/index.js"),
        );
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn handle_request_404s_for_a_missing_file() {
        let root = temp_root();
        write(&root.join("demo/manifest.json"), &manifest("demo.plugin"));

        let resp = handle_request(
            Some(&root),
            "tauri://localhost",
            &get("kdplugin://demo.plugin/nope.js"),
        );
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn handle_request_403s_on_traversal_and_still_sets_cors() {
        let root = temp_root();
        write(&root.join("demo/manifest.json"), &manifest("demo.plugin"));
        write(&root.join("secret.txt"), "outside");

        let resp = handle_request(
            Some(&root),
            "tauri://localhost",
            &get("kdplugin://demo.plugin/../secret.txt"),
        );

        assert_eq!(resp.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            resp.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
            "tauri://localhost"
        );
    }

    #[test]
    fn handle_request_404s_everything_when_plugins_root_is_absent() {
        let resp = handle_request(None, "tauri://localhost", &get("kdplugin://demo.plugin/x.js"));
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    // ---- csp / mime helpers ----

    #[test]
    fn csp_has_only_self_when_no_net_capability() {
        let csp = csp_for(&manifest("demo.plugin"));
        assert!(csp.contains("connect-src 'self';"));
        assert!(!csp.contains("http"));
    }

    #[test]
    fn csp_lists_net_domains_as_both_schemes() {
        let json = r#"{"id":"d","capabilities":[{"kind":"net","domains":["a.com","b.io"]}]}"#;
        let csp = csp_for(json);
        assert!(csp.contains("connect-src 'self' https://a.com http://a.com https://b.io http://b.io"));
    }

    #[test]
    fn content_type_for_js_and_mjs_is_text_javascript() {
        assert_eq!(content_type_for("index.js"), "text/javascript");
        assert_eq!(content_type_for("bundle.mjs"), "text/javascript");
    }

    #[test]
    fn content_type_for_html_is_text_html() {
        assert_eq!(content_type_for("index.html"), "text/html");
    }

    // ---- origin_of ----

    #[test]
    fn origin_of_renders_scheme_host_port() {
        let url = Url::parse("http://localhost:1420/index.html").unwrap();
        assert_eq!(origin_of(&url).as_deref(), Some("http://localhost:1420"));
    }

    #[test]
    fn origin_of_omits_port_when_default_or_absent() {
        let url = Url::parse("https://tauri.localhost/a/b").unwrap();
        assert_eq!(origin_of(&url).as_deref(), Some("https://tauri.localhost"));
    }
}

