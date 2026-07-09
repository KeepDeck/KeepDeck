//! Rust side of the EXTERNAL plugin tier's file serving.
//!
//! An installed external plugin is ONE OF TWO shapes on disk, both directly
//! under `<config_dir>/plugins/` (`config_dir` per
//! `crate::paths::keepdeck_home`):
//!
//! - a `.kdplugin` file — a validated, read-only zip container (the format
//!   `docs/plugin-container.md` specifies and `scripts/pack-plugin.mjs`
//!   writes);
//! - an unpacked FOLDER — one `manifest.json` plus whatever bundle files the
//!   plugin ships, DEV MODE by definition (no archive step, instant
//!   iteration).
//!
//! [`PluginSource`] is the seam between the two: `Dir` for a folder,
//! `Archive` for a container, each able to fetch a manifest and read a
//! relative path. The FILE/FOLDER NAME is cosmetic and user-chosen either
//! way; the manifest's `id` is the plugin's real identity, so every lookup
//! here goes id -> source by re-scanning and matching, never the other way
//! around. When both shapes claim the same id, the dev folder wins — the
//! point of dev mode is iterating on top of an already-installed container.
//!
//! Three things live in this module:
//!
//! - [`plugins_scan`] / [`plugins_resolve_dir`]: commands the TS loader uses
//!   to build its own id -> source map. Manifests are read RAW — this module
//!   checks only that the bytes are valid UTF-8 JSON; schema validation is
//!   `readManifest`'s job on the TS side (`packages/plugin-api`), matching
//!   how the deck's own persistence keeps schema knowledge next to the model
//!   it mirrors.
//! - container validation ([`validate_archive`]): everything a `.kdplugin`
//!   must pass before a single byte of it is ever served — see that
//!   function's doc comment for the full rule set. A violation skips just
//!   that file, the same "one bad install must never break every other
//!   plugin's listing" policy [`scan_dev_folders`] already applies to a
//!   broken folder manifest.
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
//! the plugins root, and re-open + re-validate any `.kdplugin` container, on
//! every call. Plugin counts are small (human-installed, one at a time) and
//! this keeps "just installed a plugin" work without a restart — a
//! `OnceLock` cache would need invalidation machinery for a problem that
//! isn't there yet. There is deliberately no filesystem watcher either:
//! plugin lifecycle (install/update/remove) is a manual, user-driven action,
//! and re-scanning on the next request is enough to see it.

use std::collections::HashSet;
use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::http::{header, Request, Response, StatusCode};
use tauri::utils::mime_type::MimeType;
use tauri::{AppHandle, Manager as _, Runtime, Url};
use zip::ZipArchive;

/// The external tier's URI scheme. Must match `EXTERNAL_PLUGIN_SCHEME` in
/// `src/plugins/external/url.ts` — this is the single Rust source of the
/// literal, mirrored there.
pub const EXTERNAL_PLUGIN_SCHEME: &str = "kdplugin";

/// One installed plugin as read off disk, after its source has already
/// passed whatever validation that source kind requires (a dev folder's
/// manifest is valid JSON; a `.kdplugin`'s container passed
/// [`validate_archive`] in full) — plus its manifest's raw bytes. TS needs
/// both the location and the raw JSON: the location to resolve `kdplugin://`
/// URLs, the JSON to run its own `readManifest`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPluginRecord {
    /// The last path segment under the plugins root: a dev folder's name,
    /// or a `.kdplugin` file's name (extension included). Cosmetic either
    /// way — see the module docs — but `plugins_root().join(&dir_name)` is
    /// how every lookup here turns a record back into a real path.
    pub dir_name: String,
    pub manifest_json: String,
    /// Which of the two shapes this plugin is. Dev folders are always
    /// `Dev` by definition (see module docs); a `.kdplugin` file is
    /// `Archive` — it only appears here once it has passed
    /// [`validate_archive`].
    pub source: PluginSourceKind,
}

/// The two shapes an installed external plugin can take, as reported to TS.
/// Serializes to exactly `"archive"` / `"dev"` — the union
/// `src/ipc/plugins.ts`'s `InstalledPluginRecord.source` mirrors.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginSourceKind {
    Archive,
    Dev,
}

/// Where one installed plugin's files actually live, once a path has been
/// resolved for it: an unpacked DEV folder, or a `.kdplugin` container that
/// has already passed [`validate_archive`]. The two read operations below
/// are everything [`handle_request`] needs regardless of which kind it is;
/// scanning needs more than this (enumerating and validating an archive's
/// whole entry table before any single relative path can be trusted),
/// which is why [`validate_archive`] talks to `zip` directly rather than
/// through this enum.
enum PluginSource {
    Dir(PathBuf),
    Archive(PathBuf),
}

impl PluginSource {
    /// `manifest.json`'s raw bytes, or `None` if unreadable. TS's
    /// `readManifest` (`@keepdeck/plugin-api`) does the actual schema
    /// validation — this only fetches bytes, the same split
    /// [`scan_dev_folders`] and [`validate_archive`] already keep.
    fn manifest_bytes(&self) -> Option<Vec<u8>> {
        self.read("manifest.json")
    }

    /// Bytes at `relative` inside this source: straight off disk for a
    /// `Dir`, straight out of the zip's entry table for an `Archive` — no
    /// extraction to a temp location either way. This does NOT apply the
    /// traversal guard for `Dir` — a caller serving an UNTRUSTED request
    /// path (`handle_request`) must run it through [`safe_lookup`] itself
    /// first; this is the plain "read this already-trusted relative path"
    /// primitive both that and [`manifest_bytes`](Self::manifest_bytes) sit
    /// on.
    fn read(&self, relative: &str) -> Option<Vec<u8>> {
        match self {
            PluginSource::Dir(dir) => fs::read(dir.join(relative)).ok(),
            PluginSource::Archive(path) => read_zip_entry(path, relative),
        }
    }
}

/// Zip-bomb / abuse guards, mirrored from the packer
/// (`scripts/pack-plugin.mjs`'s `MAX_ENTRIES`/`MAX_FILE_BYTES`/
/// `MAX_TOTAL_BYTES`) so a container that packs there loads here: a
/// container over any of these caps is refused outright, no partial serve.
const MAX_ENTRIES: usize = 1000;
const MAX_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 50 * 1024 * 1024;

/// The container-format revision this build understands, mirroring
/// `CONTAINER_FORMAT` in `scripts/pack-plugin.mjs`. A `container.json` with
/// a HIGHER format was written by a newer KeepDeck this build cannot safely
/// interpret and is refused outright, before anything else is read.
const CONTAINER_FORMAT: u64 = 1;

/// Read `relative` out of the `.kdplugin` at `path`, or `None` if the file
/// can't be opened, isn't a valid zip, has no such entry, or the entry can't
/// be read within [`MAX_FILE_BYTES`]. Opens fresh every call — no caching,
/// matching the rest of this module (see module docs).
fn read_zip_entry(path: &Path, relative: &str) -> Option<Vec<u8>> {
    let file = fs::File::open(path).ok()?;
    let mut archive = ZipArchive::new(file).ok()?;
    let mut entry = archive.by_name(relative).ok()?;
    read_capped(&mut entry)
}

/// Read all of `entry`, refusing anything beyond [`MAX_FILE_BYTES`] actual
/// bytes — belt-and-suspenders alongside the size check [`validate_archive`]
/// already runs against each entry's DECLARED metadata size: this one bounds
/// the bytes actually read, in case content and metadata ever disagree.
fn read_capped(entry: &mut impl std::io::Read) -> Option<Vec<u8>> {
    let mut buf = Vec::new();
    entry.take(MAX_FILE_BYTES + 1).read_to_end(&mut buf).ok()?;
    (buf.len() as u64 <= MAX_FILE_BYTES).then_some(buf)
}

/// Validate every entry name `docs/plugin-container.md` requires of a
/// `.kdplugin`: relative, forward-slash paths only. Zip-slip — an entry
/// escaping the folder it's served from — is the SAME attack class the
/// `Dir` source's canonicalize guard ([`safe_lookup`]) kills for a folder;
/// refusing it in the entry TABLE, at open time, is the `Archive`
/// equivalent, since serving one never joins a filesystem path at all (see
/// [`PluginSource::read`]).
fn validate_entry_name(name: &str) -> Result<(), String> {
    if name.contains('\\') {
        return Err("backslash in an entry name".to_string());
    }
    if name.starts_with('/') {
        return Err("absolute (leading-`/`) entry name".to_string());
    }
    let bytes = name.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err("drive-letter entry name".to_string());
    }
    if name.split('/').any(|segment| segment == "..") {
        return Err("\"..\" in an entry name".to_string());
    }
    Ok(())
}

/// Parse `container.json`'s `{ "format": N }` and return `N`. Anything else
/// — invalid UTF-8/JSON, not an object, a missing or non-numeric `format`
/// field — is rejected with a reason naming what's wrong.
fn container_format(bytes: &[u8]) -> Result<u64, String> {
    let text =
        std::str::from_utf8(bytes).map_err(|e| format!("not valid UTF-8 ({e})"))?;
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("not valid JSON ({e})"))?;
    value
        .get("format")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| "missing or non-numeric \"format\" field".to_string())
}

/// The entry count the End Of Central Directory record DECLARES — read
/// raw, without going through [`ZipArchive`]. This is the one number the
/// crate cannot provide faithfully: it resolves the central directory into
/// a name-keyed map as it parses, so two entries sharing a name silently
/// collapse into one before [`ZipArchive::len`] ever sees them. Comparing
/// this declared count against the crate's DEDUPLICATED count is therefore
/// a complete duplicate-name detector (and catches a forged or truncated
/// central directory for free) while keeping the custom parsing surface to
/// one fixed-size record — no walking of per-entry records at all.
///
/// Bounded and seek-based: reads at most the EOCD record plus the maximal
/// zip comment (64 KiB) from the file tail. ZIP64 is refused outright: a
/// container capped at [`MAX_ENTRIES`]/[`MAX_TOTAL_BYTES`] can never need
/// it, so the sentinel values only ever mean someone is probing the parser.
/// Anything that doesn't parse as a well-formed, single-disk EOCD is `Err`,
/// which [`validate_archive`] treats as a rejection — fail closed.
fn eocd_declared_entries(path: &Path) -> Result<u64, String> {
    use std::io::{Seek, SeekFrom};

    const EOCD_SIG: [u8; 4] = *b"PK\x05\x06";
    const EOCD_LEN: u64 = 22;
    const MAX_COMMENT_LEN: u64 = 65535;
    const ZIP64_U16: u16 = 0xffff;
    const ZIP64_U32: u32 = 0xffff_ffff;

    let mut file = fs::File::open(path).map_err(|e| format!("cannot open ({e})"))?;
    let file_len = file.metadata().map_err(|e| format!("cannot stat ({e})"))?.len();
    if file_len < EOCD_LEN {
        return Err("too small to be a zip archive".to_string());
    }

    let tail_len = (EOCD_LEN + MAX_COMMENT_LEN).min(file_len);
    let tail_start = file_len - tail_len;
    file.seek(SeekFrom::Start(tail_start))
        .map_err(|e| format!("seek failed ({e})"))?;
    let mut tail = vec![0u8; tail_len as usize];
    file.read_exact(&mut tail).map_err(|e| format!("read failed ({e})"))?;

    const CENTRAL_SIG: [u8; 4] = *b"PK\x01\x02";

    // Scan backward for a candidate EOCD whose comment length reaches EOF AND
    // whose declared central-directory offset points at a real central-
    // directory file header. The second check is what keeps a FORGED trailing
    // EOCD (appended after a real archive, its comment sized to reach EOF)
    // from being trusted: the `zip` crate this count cross-checks against
    // rejects such a record and falls back to the true, earlier EOCD, so
    // without the CDFH check our finder and the crate could desync and the
    // duplicate-entry guard (declared vs deduplicated count) would be
    // defeated. Requiring the offset -> CDFH makes both select the same EOCD.
    for i in (0..=tail.len() - EOCD_LEN as usize).rev() {
        if tail[i..i + 4] != EOCD_SIG {
            continue;
        }
        // Relaxed like the `zip` crate: the comment must not OVERSHOOT the
        // file, but trailing garbage after it is tolerated (the crate does
        // the same). Disambiguation between multiple candidates is the
        // offset->CDFH probe below, not an exact comment length — which is
        // also what keeps us selecting the same EOCD the crate does.
        let comment_len = u16::from_le_bytes([tail[i + 20], tail[i + 21]]) as usize;
        if i + EOCD_LEN as usize + comment_len > tail.len() {
            continue;
        }
        let disk = u16::from_le_bytes([tail[i + 4], tail[i + 5]]);
        let entries_this_disk = u16::from_le_bytes([tail[i + 8], tail[i + 9]]);
        let total_entries = u16::from_le_bytes([tail[i + 10], tail[i + 11]]);
        let central_dir_size =
            u32::from_le_bytes([tail[i + 12], tail[i + 13], tail[i + 14], tail[i + 15]]);
        let central_dir_offset =
            u32::from_le_bytes([tail[i + 16], tail[i + 17], tail[i + 18], tail[i + 19]]);
        if total_entries == ZIP64_U16
            || central_dir_size == ZIP64_U32
            || central_dir_offset == ZIP64_U32
        {
            return Err("ZIP64 containers are not supported".to_string());
        }
        if disk != 0 || entries_this_disk != total_entries {
            return Err("multi-disk zip archives are not supported".to_string());
        }
        // Verify the central directory actually starts where this EOCD says.
        // An empty archive (0 entries, 0 size) legitimately has no CDFH, so
        // it's accepted without the signature probe.
        if total_entries == 0 {
            return Ok(0);
        }
        let cd_offset = central_dir_offset as u64;
        if cd_offset + 4 > file_len {
            continue; // offset past EOF — a forged record, keep scanning
        }
        let mut sig = [0u8; 4];
        file.seek(SeekFrom::Start(cd_offset))
            .map_err(|e| format!("seek failed ({e})"))?;
        file.read_exact(&mut sig).map_err(|e| format!("read failed ({e})"))?;
        if sig == CENTRAL_SIG {
            return Ok(total_entries as u64);
        }
        // Offset didn't land on a header — not the real EOCD; keep scanning.
    }
    Err("no end-of-central-directory record found".to_string())
}

/// Open `path` as a `.kdplugin` container and validate it end to end
/// against the rules `docs/plugin-container.md` documents (mirrored from
/// the packer, `scripts/pack-plugin.mjs`, so a container that packs there
/// loads here) — in order:
///
/// 1. the EOCD-declared entry count is within [`MAX_ENTRIES`] and MATCHES
///    the crate's deduplicated view — a mismatch means duplicate names (or
///    a forged central directory), see [`eocd_declared_entries`]; every
///    name then passes [`validate_entry_name`];
/// 2. none of them is a symlink (checked via `unix_mode`/`is_symlink` — a
///    zip "symlink" is a regular entry whose CONTENT is a target path, so
///    reading it as a normal file would silently hand back a path string
///    instead of refusing; the same "no symlinks" policy [`safe_lookup`]
///    enforces for a `Dir` source), and each is within [`MAX_FILE_BYTES`],
///    with the running total within [`MAX_TOTAL_BYTES`] — zip-bomb and
///    zip-slip are the SAME attack class the `Dir` source's canonicalize
///    guard already kills for folders; refusing both in the entry table,
///    before a single byte of content is read, is the `Archive` equivalent;
/// 3. `container.json` exists and its `format` is one this build
///    understands;
/// 4. `manifest.json` exists.
///
/// Returns manifest.json's raw bytes on success; `Err(reason)` is a
/// human-readable rejection reason for the caller to log alongside the file
/// name — nothing here is ever served or trusted before every check above
/// has passed.
fn validate_archive(path: &Path) -> Result<Vec<u8>, String> {
    let declared = eocd_declared_entries(path)?;
    if declared > MAX_ENTRIES as u64 {
        return Err(format!(
            "{declared} entries exceeds the {MAX_ENTRIES}-entry cap"
        ));
    }

    let file = fs::File::open(path).map_err(|e| format!("cannot open ({e})"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("not a valid zip archive ({e})"))?;
    // The crate deduplicates names while parsing; the declared count doesn't.
    // Equality is therefore the whole duplicate check — after it, the
    // name-keyed view is faithful and everything else can go through it.
    if archive.len() as u64 != declared {
        return Err(format!(
            "central directory declares {declared} entries but {} distinct names parse — duplicate or forged entries",
            archive.len()
        ));
    }

    let names: Vec<String> = archive.file_names().map(str::to_owned).collect();
    let mut seen = HashSet::with_capacity(names.len());
    for name in &names {
        seen.insert(name.as_str());
        if let Err(reason) = validate_entry_name(name) {
            return Err(format!("{name:?}: {reason}"));
        }
    }

    let mut total_bytes: u64 = 0;
    for name in &names {
        let entry = archive
            .by_name(name)
            .map_err(|e| format!("{name:?}: unreadable ({e})"))?;
        if entry.is_symlink() {
            return Err(format!("{name:?}: symlink entries are not allowed"));
        }
        let size = entry.size();
        if size > MAX_FILE_BYTES {
            return Err(format!(
                "{name:?}: {size} bytes exceeds the {MAX_FILE_BYTES}-byte per-file cap"
            ));
        }
        total_bytes = total_bytes.saturating_add(size);
        if total_bytes > MAX_TOTAL_BYTES {
            return Err(format!(
                "total uncompressed size exceeds the {MAX_TOTAL_BYTES}-byte cap"
            ));
        }
    }
    drop(archive); // the two fetches below reopen fresh through `PluginSource`.

    if !seen.contains("container.json") {
        return Err("container.json: required entry is missing".to_string());
    }
    let container_json = PluginSource::Archive(path.to_path_buf())
        .read("container.json")
        .ok_or_else(|| "container.json: unreadable".to_string())?;
    let format = container_format(&container_json)?;
    if format > CONTAINER_FORMAT {
        return Err(format!(
            "created by a newer KeepDeck (container format {format}, this build reads {CONTAINER_FORMAT})"
        ));
    }

    if !seen.contains("manifest.json") {
        return Err("manifest.json: required entry is missing".to_string());
    }
    PluginSource::Archive(path.to_path_buf())
        .manifest_bytes()
        .ok_or_else(|| "manifest.json: unreadable".to_string())
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

/// List every installed plugin: every validated `.kdplugin` archive, THEN
/// every dev folder. A missing plugins folder (first run, or no config dir
/// at all) is an empty list, not an error.
///
/// The two tiers are each sorted by name — archives by file name, dev
/// folders by folder name — for a deterministic, reproducible order, but
/// the ORDER OF THE TIERS is not itself a priority rule: [`resolve`] does
/// its own dev-wins-over-archive pass rather than taking "first in this
/// list". This function's return order is a documented, tested contract in
/// its own right (a duplicate id across an archive and a dev folder must
/// still land the same two records in the same relative order every call),
/// it just isn't the thing that decides which one serves a given id.
#[tauri::command(async)]
pub fn plugins_scan() -> Vec<InstalledPluginRecord> {
    plugins_root().map(|root| scan(&root)).unwrap_or_default()
}

/// The folder or `.kdplugin` file currently providing plugin `id`, or
/// `None` if no installed plugin declares it. Re-scans (and, for an
/// archive, re-validates) on every call; a dev folder wins over an archive
/// declaring the same id — mirroring the TS reconciler's rule so the
/// `kdplugin://` scheme serves exactly the source it chose — with ties
/// within a tier broken by `scan`'s sort order.
#[tauri::command(async)]
pub fn plugins_resolve_dir(id: String) -> Option<String> {
    let root = plugins_root()?;
    resolve(&root, &id).map(|record| record.dir_name)
}

/// Resolve a Resource-dir-relative path to an absolute file path, `None`
/// when absent. Backs `ctx.resources.path` for BUILT-IN plugins: in a
/// bundle their built dirs ship as real files under `Resources/plugins/`;
/// in dev the Resource base is `src-tauri/`, so the caller points into the
/// source tree (`../plugins/<dir>/resources/...`). Resolution only — no
/// contents cross this boundary, and the webview is the same trust domain
/// that could read these files through its own asset scope anyway.
#[tauri::command]
pub fn plugin_resource_path(app: tauri::AppHandle, path: String) -> Option<String> {
    use tauri::Manager as _;
    let resolved = app
        .path()
        .resolve(path, tauri::path::BaseDirectory::Resource)
        .ok()?;
    let canonical = resolved.canonicalize().ok()?;
    canonical
        .is_file()
        .then(|| canonical.to_string_lossy().into_owned())
}

/// Every archive, sorted by file name, then every dev folder, sorted by
/// folder name — see [`plugins_scan`] for why the two tiers are kept in
/// this fixed relative order rather than merged by name across both.
fn scan(root: &Path) -> Vec<InstalledPluginRecord> {
    let mut records = scan_archives(root);
    records.extend(scan_dev_folders(root));
    records
}

/// Scan `<root>/*.kdplugin`. A container that fails [`validate_archive`] —
/// wrong container format, a bad entry table, missing `manifest.json`, and
/// so on — is skipped with a `log::warn!` naming the file and the reason,
/// same "one bad install must never break every other plugin's listing"
/// policy [`scan_dev_folders`] applies to a broken folder. Sorted by file
/// name.
/// Sorted `(name, path)` for every direct child of `root` that `keep`
/// accepts — the shared listing under both the archive and dev-folder scans
/// and the per-request `resolve`. A missing/unreadable `root` lists nothing.
fn sorted_entries(root: &Path, keep: impl Fn(&Path) -> bool) -> Vec<(String, PathBuf)> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<(String, PathBuf)> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| keep(path))
        .filter_map(|path| Some((path.file_name()?.to_string_lossy().into_owned(), path)))
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn is_archive(path: &Path) -> bool {
    path.is_file() && path.extension().is_some_and(|ext| ext == "kdplugin")
}

fn scan_archives(root: &Path) -> Vec<InstalledPluginRecord> {
    sorted_entries(root, is_archive)
        .into_iter()
        .filter_map(|(file_name, path)| match validate_archive(&path) {
            Ok(manifest_bytes) => match String::from_utf8(manifest_bytes) {
                Ok(manifest_json) => Some(InstalledPluginRecord {
                    dir_name: file_name,
                    manifest_json,
                    source: PluginSourceKind::Archive,
                }),
                Err(e) => {
                    log::warn!("plugins scan: {file_name}: manifest.json is not valid UTF-8 ({e})");
                    None
                }
            },
            Err(reason) => {
                log::warn!("plugins scan: {file_name}: {reason}");
                None
            }
        })
        .collect()
}

/// Scan `<root>/*/manifest.json`. A folder whose manifest is missing, not
/// UTF-8, or not well-formed JSON is skipped with a `log::warn!` naming the
/// folder — one bad install must never break every other plugin's listing.
/// Sorted by folder name.
fn scan_dev_folders(root: &Path) -> Vec<InstalledPluginRecord> {
    sorted_entries(root, |path| path.is_dir())
        .into_iter()
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
                source: PluginSourceKind::Dev,
            })
        })
        .collect()
}

/// The record whose manifest `id` matches, preferring a dev folder over an
/// archive — mirroring the TS reconciler's duplicate-id rule (see module
/// docs) — and otherwise the first match in sorted order within whichever
/// tier wins.
///
/// Unlike a full [`scan`], this validates only the ONE container it decides
/// to serve: candidates are matched by a CHEAP manifest-id peek (a raw
/// manifest read, no entry-table validation), and the winning archive is put
/// through [`validate_archive`] only once its id matches — so serving an
/// asset never re-validates every other installed plugin's container. A
/// candidate whose id matches but fails validation is skipped, falling
/// through to the next claimant of that id (mirroring `scan`'s drop policy).
fn resolve(root: &Path, id: &str) -> Option<InstalledPluginRecord> {
    // Dev folders first (they win a shared id), then archives; each tier in
    // its own sorted order.
    let dev = sorted_entries(root, |p| p.is_dir())
        .into_iter()
        .map(|(name, path)| (PluginSourceKind::Dev, name, path));
    let archives = sorted_entries(root, is_archive)
        .into_iter()
        .map(|(name, path)| (PluginSourceKind::Archive, name, path));

    for (kind, name, path) in dev.chain(archives) {
        match kind {
            PluginSourceKind::Dev => {
                let Ok(raw) = fs::read_to_string(path.join("manifest.json")) else {
                    continue;
                };
                if manifest_id(&raw).as_deref() != Some(id) {
                    continue;
                }
                // Dev "validation" is only well-formed JSON — the id peek
                // above already parsed it.
                return Some(InstalledPluginRecord {
                    dir_name: name,
                    manifest_json: raw,
                    source: PluginSourceKind::Dev,
                });
            }
            PluginSourceKind::Archive => {
                let peeked = read_zip_entry(&path, "manifest.json")
                    .and_then(|b| String::from_utf8(b).ok());
                if peeked.as_deref().and_then(manifest_id).as_deref() != Some(id) {
                    continue;
                }
                // The id matches — now fully validate this one container.
                match validate_archive(&path).and_then(|b| String::from_utf8(b).map_err(|e| e.to_string())) {
                    Ok(manifest_json) => {
                        return Some(InstalledPluginRecord {
                            dir_name: name,
                            manifest_json,
                                    source: PluginSourceKind::Archive,
                        });
                    }
                    Err(reason) => {
                        log::warn!("kdplugin: {name}: {reason}");
                        // Fall through to the next claimant of this id.
                    }
                }
            }
        }
    }
    None
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

/// The reserved document path a plugin's logic realm boots from. NEVER read
/// from the plugin's own source, even if it ships an entry at this exact
/// name: [`handle_request`] intercepts it before either `PluginSource`
/// variant is consulted, so a shipped `__main__.html` is silently shadowed.
const MAIN_HTML_PATH: &str = "__main__.html";

/// The fixed entry-bundle name. A plugin's code lives in `main.js` at its
/// root — a convention, not a declaration (the manifest carries no entry
/// field), so an author writes zero boilerplate; a plugin with no `main.js`
/// is pure UI and boots no realm.
const MAIN_JS: &str = "main.js";

/// The synthesized `__main__.html` body: the minimal same-origin document
/// that loads `/main.js` as a module and boots the logic realm inside it, so
/// authors never hand-write a wrapper. The src is a fixed, root-relative
/// literal (no manifest input reaches this markup), resolving under the
/// plugin's own `kdplugin://<id>` origin.
const MAIN_HTML_BODY: &[u8] =
    b"<!doctype html><meta charset=\"utf-8\"><script type=\"module\" src=\"/main.js\"></script>";

/// Handle one `kdplugin://<plugin-id>/<path>` request. Pure and synchronous
/// so it's unit-testable without a running Tauri app; `lib.rs`'s
/// registration supplies the real plugins root (`None` when there's no
/// config dir at all) and a `window_origin` computed from the requesting
/// webview via [`window_origin`].
///
/// Status codes: 400 for a host-less/empty-host URL (malformed), 404 for no
/// such plugin or no such file, 403 for a path that escapes a `Dir` source's
/// own folder (see [`safe_lookup`] — an `Archive` source has no equivalent,
/// since a zip name lookup never touches a filesystem path), 200 otherwise.
/// Every response — including the error ones — carries
/// `Access-Control-Allow-Origin` and `Cache-Control: no-cache` (see
/// [`respond`]): a runtime plugin restart must re-fetch the new container's
/// bytes, so correctness beats caching at plugin scale.
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

    let path = plugins_root.join(&record.dir_name);
    let source = match record.source {
        PluginSourceKind::Dev => PluginSource::Dir(path),
        PluginSourceKind::Archive => PluginSource::Archive(path),
    };

    let relative = request.uri().path().trim_start_matches('/');

    let body = if relative == MAIN_HTML_PATH {
        // Reserved name (see `MAIN_HTML_PATH`): the fixed wrapper that loads
        // the plugin's `main.js`. Every plugin ships one (code is the point of
        // a plugin), so this is unconditional; the markup is a literal with no
        // plugin input. A plugin missing its `main.js` fails when the module
        // 404s inside the realm, not here.
        MAIN_HTML_BODY.to_vec()
    } else {
        match read_relative(&source, host, relative) {
            Ok(bytes) => bytes,
            Err(status) => return respond(window_origin, status, None, None, Vec::new()),
        }
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

/// Bytes at `relative` inside `source`, or the status to fail the request
/// with. A `Dir` keeps the canonicalize traversal guard ([`safe_lookup`]),
/// unchanged from before archives existed. An `Archive`'s entries were
/// already vetted for traversal-style names when the container was
/// validated (see [`validate_archive`]), and a zip name lookup can't escape
/// its own file the way a filesystem join can — so there is no equivalent
/// 403 for it, only 404 for an absent entry.
fn read_relative(source: &PluginSource, host: &str, relative: &str) -> Result<Vec<u8>, StatusCode> {
    match source {
        PluginSource::Dir(dir) => match safe_lookup(dir, relative) {
            Lookup::Found(path) => fs::read(&path).map_err(|_| StatusCode::NOT_FOUND),
            Lookup::NotFound => Err(StatusCode::NOT_FOUND),
            Lookup::Escaped => {
                log::warn!("kdplugin: refused a path escaping {host}'s folder: {relative}");
                Err(StatusCode::FORBIDDEN)
            }
        },
        PluginSource::Archive(_) => source.read(relative).ok_or(StatusCode::NOT_FOUND),
    }
}

/// Build one response, always attaching the headers every branch of
/// [`handle_request`] must carry regardless of success or failure: CORS
/// (scoped to the requesting window, matching how `crates/tauri`'s own
/// "asset" protocol behaves rather than a blanket `*`) and `no-cache` (see
/// [`handle_request`]'s doc comment).
fn respond(
    origin: &str,
    status: StatusCode,
    csp: Option<&str>,
    content_type: Option<&str>,
    body: Vec<u8>,
) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin)
        .header(header::CACHE_CONTROL, "no-cache");
    if let Some(content_type) = content_type {
        builder = builder.header(header::CONTENT_TYPE, content_type);
    }
    if let Some(csp) = csp {
        builder = builder.header(header::CONTENT_SECURITY_POLICY, csp);
    }
    // Build fallibly: a header value the http crate rejects (e.g. a CR/LF a
    // hostile manifest smuggled into the CSP) must not panic the whole
    // webview — drop to a bare, self-only response instead. The CSP is
    // additionally sanitized upstream (`csp_for` skips non-hostname domains),
    // so this is defense in depth, not the primary guard.
    match builder.body(body) {
        Ok(response) => response,
        Err(_) => Response::builder()
            .status(StatusCode::INTERNAL_SERVER_ERROR)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "null")
            .header(header::CACHE_CONTROL, "no-cache")
            .body(Vec::new())
            .expect("the minimal fallback response is always valid"),
    }
}

/// Content-Type from the file extension. `tauri_utils::MimeType` covers the
/// web-code types (`.js`/`.mjs` -> `text/javascript` matters — an ES module
/// won't execute under the wrong MIME in a strict context), but its fallback
/// for ANY unrecognized suffix is `text/html`, which silently breaks strict
/// consumers of plugin assets (`.wasm` rejected by `instantiateStreaming`,
/// fonts, source maps). So the common binary asset types are mapped
/// explicitly first, and the true fallback is `application/octet-stream` —
/// never `text/html` for a file we don't recognize.
fn content_type_for(relative: &str) -> String {
    let ext = relative.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "map" => "application/json",
        "webmanifest" => "application/manifest+json",
        // A recognized web-code/text type -> tauri_utils; anything else it
        // doesn't know becomes octet-stream, not the misleading text/html.
        _ => {
            return match MimeType::parse_from_uri(relative) {
                MimeType::Html if ext != "html" && ext != "htm" => {
                    "application/octet-stream".to_string()
                }
                other => other.to_string(),
            };
        }
    }
    .to_string()
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
        // A dev-folder manifest never passed TS validation, so re-check the
        // hostname grammar HERE before splicing into the header — a value
        // with a space/`;`/CR/LF would inject a CSP directive or break the
        // header. Anything that isn't a bare hostname is dropped, not served.
        if is_bare_hostname(&domain) {
            connect_src.push_str(&format!(" https://{domain} http://{domain}"));
        } else {
            log::warn!("kdplugin: dropped a non-hostname net domain from CSP: {domain:?}");
        }
    }
    format!(
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
         connect-src {connect_src}; img-src 'self' data:"
    )
}

/// Whether `s` is a bare hostname (dotted labels / `localhost` / IPv4) with
/// an optional `:port` — the same shape the TS validator's `HOSTNAME` grammar
/// enforces, re-stated here as the last line of defense before a domain is
/// spliced into a CSP header (dev-folder manifests reach here unvalidated).
fn is_bare_hostname(s: &str) -> bool {
    if s.is_empty() || s.len() > 253 {
        return false;
    }
    let (host, port) = match s.rsplit_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (s, None),
    };
    if let Some(p) = port {
        if p.is_empty() || p.len() > 5 || !p.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
    }
    !host.is_empty()
        && host.split('.').all(|label| {
            !label.is_empty()
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
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
    use std::io::Write as _;
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
        format!(r#"{{"id":"{id}","name":"n","version":"0.0.1","minApiVersion":1,"capabilities":[]}}"#)
    }

    /// Build a `.kdplugin` at `path` from `(name, content)` entries, STORED
    /// (uncompressed) — the same on-disk shape `scripts/pack-plugin.mjs`
    /// writes. `zip`'s writer half is unconditional (not feature-gated, see
    /// `Cargo.toml`'s comment on the dependency), so this needs nothing
    /// beyond what the production code already pulls in.
    fn write_container(path: &Path, entries: &[(String, Vec<u8>)]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let file = fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        for (name, data) in entries {
            zip.start_file(name.as_str(), options).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
    }

    /// A minimal, fully VALID container's entries: `container.json` at
    /// format 1, plus a manifest declaring `id`. Individual tests push more
    /// entries on top, or build their own from scratch, to probe one
    /// violation at a time.
    fn valid_container_entries(id: &str) -> Vec<(String, Vec<u8>)> {
        vec![
            ("container.json".to_string(), br#"{"format":1}"#.to_vec()),
            ("manifest.json".to_string(), manifest(id).into_bytes()),
        ]
    }

    /// A hand-rolled minimal STORED zip byte builder, ported from the same
    /// fixed, tiny algorithm `scripts/pack-plugin.mjs` uses (local headers +
    /// central directory + EOCD, no compression) — used ONLY where `zip`'s
    /// own writer refuses to produce the bytes we need to test against (it
    /// rejects a duplicate filename at `start_file` time, which is exactly
    /// the pathological case `validate_archive`'s duplicate guard exists
    /// for). Every other test builds containers through the real crate's
    /// writer via [`write_container`].
    fn raw_stored_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        fn crc32(data: &[u8]) -> u32 {
            let mut crc = 0xFFFF_FFFFu32;
            for &byte in data {
                crc ^= byte as u32;
                for _ in 0..8 {
                    let mask = (crc & 1).wrapping_neg();
                    crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
                }
            }
            !crc
        }

        let mut locals = Vec::new();
        let mut centrals = Vec::new();
        let mut offset: u32 = 0;
        for (name, data) in entries {
            let name_bytes = name.as_bytes();
            let crc = crc32(data);

            let mut local = Vec::new();
            local.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            local.extend_from_slice(&20u16.to_le_bytes()); // version needed
            local.extend_from_slice(&0x0800u16.to_le_bytes()); // flags: UTF-8 names
            local.extend_from_slice(&0u16.to_le_bytes()); // method: stored
            local.extend_from_slice(&0u32.to_le_bytes()); // time+date
            local.extend_from_slice(&crc.to_le_bytes());
            local.extend_from_slice(&(data.len() as u32).to_le_bytes());
            local.extend_from_slice(&(data.len() as u32).to_le_bytes());
            local.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
            local.extend_from_slice(&0u16.to_le_bytes()); // extra length
            local.extend_from_slice(name_bytes);
            local.extend_from_slice(data);

            let mut central = Vec::new();
            central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            central.extend_from_slice(&20u16.to_le_bytes()); // version made by
            central.extend_from_slice(&20u16.to_le_bytes()); // version needed
            central.extend_from_slice(&0x0800u16.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes());
            central.extend_from_slice(&0u32.to_le_bytes());
            central.extend_from_slice(&crc.to_le_bytes());
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes()); // extra length
            central.extend_from_slice(&0u16.to_le_bytes()); // comment length
            central.extend_from_slice(&0u16.to_le_bytes()); // disk number start
            central.extend_from_slice(&0u16.to_le_bytes()); // internal attrs
            central.extend_from_slice(&0u32.to_le_bytes()); // external attrs
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name_bytes);

            offset += local.len() as u32;
            locals.push(local);
            centrals.push(central);
        }

        let central_start = offset;
        let central_bytes: Vec<u8> = centrals.concat();

        let mut eocd = Vec::new();
        eocd.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        eocd.extend_from_slice(&0u32.to_le_bytes()); // disk numbers
        eocd.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        eocd.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        eocd.extend_from_slice(&(central_bytes.len() as u32).to_le_bytes());
        eocd.extend_from_slice(&central_start.to_le_bytes());
        eocd.extend_from_slice(&0u16.to_le_bytes()); // comment length

        let mut out = Vec::new();
        for local in locals {
            out.extend_from_slice(&local);
        }
        out.extend_from_slice(&central_bytes);
        out.extend_from_slice(&eocd);
        out
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

    // ---- PluginSource ----

    #[test]
    fn plugin_source_dir_reads_manifest_and_a_relative_path() {
        let root = temp_root();
        write(&root.join("plugin/manifest.json"), &manifest("dir.plugin"));
        write(&root.join("plugin/index.js"), "console.log(1)");

        let source = PluginSource::Dir(root.join("plugin"));

        assert_eq!(
            source.manifest_bytes(),
            Some(manifest("dir.plugin").into_bytes())
        );
        assert_eq!(source.read("index.js"), Some(b"console.log(1)".to_vec()));
        assert_eq!(source.read("nope.txt"), None);
    }

    #[test]
    fn plugin_source_archive_reads_an_entry_straight_from_the_zip_no_extraction() {
        let root = temp_root();
        let path = root.join("demo.kdplugin");
        let mut entries = valid_container_entries("archive.plugin");
        entries.push(("index.js".to_string(), b"console.log(1)".to_vec()));
        write_container(&path, &entries);

        let source = PluginSource::Archive(path);

        assert_eq!(
            source.manifest_bytes(),
            Some(manifest("archive.plugin").into_bytes())
        );
        assert_eq!(source.read("index.js"), Some(b"console.log(1)".to_vec()));
        assert_eq!(source.read("nope.txt"), None);
    }

    // ---- container validation (validate_archive) ----

    #[test]
    fn valid_container_is_scanned_with_its_manifest_preserved_verbatim() {
        let root = temp_root();
        let raw = manifest("packed.plugin");
        write_container(&root.join("Packed.kdplugin"), &valid_container_entries("packed.plugin"));

        let found = scan(&root);

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].dir_name, "Packed.kdplugin");
        assert_eq!(found[0].manifest_json, raw);
        assert_eq!(found[0].source, PluginSourceKind::Archive);
    }

    #[test]
    fn archives_sort_by_file_name_before_dev_folders_by_folder_name() {
        let root = temp_root();
        write_container(&root.join("zeta.kdplugin"), &valid_container_entries("zeta.archive"));
        write_container(&root.join("alpha.kdplugin"), &valid_container_entries("alpha.archive"));
        write(&root.join("bravo/manifest.json"), &manifest("bravo.dev"));

        let found = scan(&root);

        assert_eq!(
            found.iter().map(|r| r.dir_name.as_str()).collect::<Vec<_>>(),
            vec!["alpha.kdplugin", "zeta.kdplugin", "bravo"]
        );
    }

    #[test]
    fn container_format_newer_than_this_build_is_skipped_with_the_exact_reason() {
        let root = temp_root();
        let path = root.join("newer.kdplugin");
        write_container(
            &path,
            &[
                ("container.json".to_string(), br#"{"format":2}"#.to_vec()),
                ("manifest.json".to_string(), manifest("newer.plugin").into_bytes()),
            ],
        );

        assert_eq!(
            validate_archive(&path),
            Err("created by a newer KeepDeck (container format 2, this build reads 1)".to_string())
        );
        assert_eq!(scan(&root), Vec::new());
    }

    #[test]
    fn missing_container_json_is_skipped() {
        let root = temp_root();
        let path = root.join("no-container.kdplugin");
        write_container(
            &path,
            &[("manifest.json".to_string(), manifest("x").into_bytes())],
        );

        assert!(validate_archive(&path).is_err());
        assert_eq!(scan(&root), Vec::new());
    }

    #[test]
    fn missing_manifest_json_is_skipped() {
        let root = temp_root();
        let path = root.join("no-manifest.kdplugin");
        write_container(&path, &[("container.json".to_string(), br#"{"format":1}"#.to_vec())]);

        assert!(validate_archive(&path).is_err());
        assert_eq!(scan(&root), Vec::new());
    }

    #[test]
    fn dotdot_entry_name_is_skipped() {
        let root = temp_root();
        let path = root.join("evil.kdplugin");
        let mut entries = valid_container_entries("evil.plugin");
        entries.push(("../escape.txt".to_string(), b"boo".to_vec()));
        write_container(&path, &entries);

        let err = validate_archive(&path).unwrap_err();
        assert!(err.contains(".."), "expected a \"..\" reason, got: {err}");
        assert_eq!(scan(&root), Vec::new());
    }

    #[test]
    fn duplicate_entry_name_is_skipped() {
        let root = temp_root();
        let path = root.join("dup.kdplugin");
        let manifest_json = manifest("dup.plugin");
        // `zip`'s own writer refuses a duplicate filename outright, so a
        // duplicate entry table has to be forged at the byte level — see
        // `raw_stored_zip`.
        let bytes = raw_stored_zip(&[
            ("container.json", br#"{"format":1}"#),
            ("manifest.json", manifest_json.as_bytes()),
            ("index.js", b"1"),
            ("index.js", b"2"),
        ]);
        fs::create_dir_all(&root).unwrap();
        fs::write(&path, bytes).unwrap();

        let err = validate_archive(&path).unwrap_err();
        assert!(err.contains("duplicate"), "expected a duplicate reason, got: {err}");
        assert_eq!(scan(&root), Vec::new());
    }

    #[test]
    fn oversized_file_entry_is_skipped() {
        let root = temp_root();
        let path = root.join("huge.kdplugin");
        let mut entries = valid_container_entries("huge.plugin");
        entries.push(("huge.bin".to_string(), vec![0u8; (MAX_FILE_BYTES + 1) as usize]));
        write_container(&path, &entries);

        let err = validate_archive(&path).unwrap_err();
        assert!(err.contains("per-file cap"), "expected a per-file-cap reason, got: {err}");
        assert_eq!(scan(&root), Vec::new());
    }

    #[test]
    fn total_uncompressed_size_over_the_cap_is_skipped() {
        let root = temp_root();
        let path = root.join("bloated.kdplugin");
        let mut entries = valid_container_entries("bloated.plugin");
        // Three files just under the per-file cap comfortably clear the
        // smaller total cap without tripping the per-file one individually.
        for i in 0..3 {
            entries.push((format!("f{i}.bin"), vec![0u8; MAX_FILE_BYTES as usize]));
        }
        write_container(&path, &entries);

        let err = validate_archive(&path).unwrap_err();
        assert!(err.contains("total"), "expected a total-size reason, got: {err}");
        assert_eq!(scan(&root), Vec::new());
    }

    #[test]
    fn too_many_entries_is_skipped() {
        let root = temp_root();
        let path = root.join("swarm.kdplugin");
        let mut entries = valid_container_entries("swarm.plugin");
        for i in 0..1000 {
            entries.push((format!("f{i}.txt"), Vec::new()));
        }
        write_container(&path, &entries);

        let err = validate_archive(&path).unwrap_err();
        assert!(err.contains("entry cap"), "expected an entry-cap reason, got: {err}");
        assert_eq!(scan(&root), Vec::new());
    }

    #[test]
    fn symlink_entry_is_skipped() {
        let root = temp_root();
        let path = root.join("linked.kdplugin");
        fs::create_dir_all(root.clone()).unwrap();
        let file = fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("container.json", options).unwrap();
        zip.write_all(br#"{"format":1}"#).unwrap();
        zip.start_file("manifest.json", options).unwrap();
        zip.write_all(manifest("linked.plugin").as_bytes()).unwrap();
        zip.add_symlink("escape", "../../etc/passwd", options).unwrap();
        zip.finish().unwrap();

        let err = validate_archive(&path).unwrap_err();
        assert!(err.contains("symlink"), "expected a symlink reason, got: {err}");
        assert_eq!(scan(&root), Vec::new());
    }

    // ---- archive vs dev resolve ----

    #[test]
    fn resolve_prefers_a_dev_folder_over_an_archive_with_the_same_id() {
        let root = temp_root();
        write_container(&root.join("packed.kdplugin"), &valid_container_entries("dup.id"));
        write(&root.join("wip/manifest.json"), &manifest("dup.id"));

        let resolved = resolve(&root, "dup.id").expect("dup.id should resolve");
        assert_eq!(resolved.dir_name, "wip");
        assert_eq!(resolved.source, PluginSourceKind::Dev);
    }

    #[test]
    fn resolve_falls_back_to_an_archive_when_no_dev_folder_claims_the_id() {
        let root = temp_root();
        write_container(&root.join("packed.kdplugin"), &valid_container_entries("archive-only.id"));

        let resolved = resolve(&root, "archive-only.id").expect("archive-only.id should resolve");
        assert_eq!(resolved.dir_name, "packed.kdplugin");
        assert_eq!(resolved.source, PluginSourceKind::Archive);
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
            r#"{"id":"demo.plugin","name":"n","version":"0.0.1","minApiVersion":1,
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

    // ---- the full request handler: serving from an archive ----

    #[test]
    fn handle_request_serves_bytes_mime_and_csp_from_an_archive() {
        let root = temp_root();
        let manifest_json = r#"{"id":"demo.archive","name":"n","version":"0.0.1","minApiVersion":1,
            "capabilities":[{"kind":"net","domains":["api.example.com"]}]}"#;
        write_container(
            &root.join("demo.kdplugin"),
            &[
                ("container.json".to_string(), br#"{"format":1}"#.to_vec()),
                ("manifest.json".to_string(), manifest_json.as_bytes().to_vec()),
                ("index.js".to_string(), b"console.log(1)".to_vec()),
                ("index.html".to_string(), b"<html></html>".to_vec()),
            ],
        );

        let js = handle_request(
            Some(&root),
            "tauri://localhost",
            &get("kdplugin://demo.archive/index.js"),
        );
        assert_eq!(js.status(), StatusCode::OK);
        assert_eq!(
            js.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
            "tauri://localhost"
        );
        assert_eq!(js.headers().get(header::CONTENT_TYPE).unwrap(), "text/javascript");
        assert_eq!(js.body(), b"console.log(1)");

        let html = handle_request(
            Some(&root),
            "tauri://localhost",
            &get("kdplugin://demo.archive/index.html"),
        );
        let csp = html
            .headers()
            .get(header::CONTENT_SECURITY_POLICY)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(csp.contains("connect-src 'self' https://api.example.com http://api.example.com"));
    }

    #[test]
    fn handle_request_404s_for_an_absent_entry_in_an_archive_no_403() {
        let root = temp_root();
        write_container(&root.join("demo.kdplugin"), &valid_container_entries("demo.archive"));

        let resp = handle_request(
            Some(&root),
            "tauri://localhost",
            &get("kdplugin://demo.archive/../secret.txt"),
        );

        // An archive has no filesystem join to escape, so even a
        // traversal-shaped request path is just an entry name that doesn't
        // exist — 404, never the `Dir` source's 403.
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    // ---- __main__.html synthesis ----

    #[test]
    fn main_html_is_synthesized_when_main_js_exists_dev() {
        let root = temp_root();
        write(&root.join("demo/manifest.json"), &manifest("demo.plugin"));
        write(&root.join("demo/main.js"), "export default 1;");

        let resp = handle_request(
            Some(&root),
            "tauri://localhost",
            &get("kdplugin://demo.plugin/__main__.html"),
        );

        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.headers().get(header::CONTENT_TYPE).unwrap(), "text/html");
        assert_eq!(resp.body(), MAIN_HTML_BODY);
    }

    #[test]
    fn main_html_is_synthesized_when_main_js_exists_archive() {
        let root = temp_root();
        let mut entries = valid_container_entries("demo.archive");
        entries.push(("main.js".to_string(), b"export default 1;".to_vec()));
        write_container(&root.join("demo.kdplugin"), &entries);

        let resp = handle_request(
            Some(&root),
            "tauri://localhost",
            &get("kdplugin://demo.archive/__main__.html"),
        );

        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.body(), MAIN_HTML_BODY);
    }

    #[test]
    fn main_html_shadows_a_shipped_one() {
        let root = temp_root();
        write(&root.join("demo/manifest.json"), &manifest("demo.plugin"));
        write(&root.join("demo/main.js"), "export default 1;");
        // A plugin shipping its own __main__.html gets the synthesized one.
        write(&root.join("demo/__main__.html"), "<html>REAL, SHIPPED</html>");

        let resp = handle_request(
            Some(&root),
            "tauri://localhost",
            &get("kdplugin://demo.plugin/__main__.html"),
        );

        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(resp.body(), MAIN_HTML_BODY);
    }

    // ---- Cache-Control ----

    #[test]
    fn every_response_carries_no_cache_for_both_dir_and_archive_sources() {
        let root = temp_root();
        write(&root.join("dev/manifest.json"), &manifest("dev.plugin"));
        write(&root.join("dev/index.js"), "1");
        let mut entries = valid_container_entries("packed.plugin");
        entries.push(("index.js".to_string(), b"1".to_vec()));
        write_container(&root.join("packed.kdplugin"), &entries);

        let dev = handle_request(
            Some(&root),
            "tauri://localhost",
            &get("kdplugin://dev.plugin/index.js"),
        );
        let archive = handle_request(
            Some(&root),
            "tauri://localhost",
            &get("kdplugin://packed.plugin/index.js"),
        );
        let not_found = handle_request(
            Some(&root),
            "tauri://localhost",
            &get("kdplugin://nobody/index.js"),
        );

        assert_eq!(dev.headers().get(header::CACHE_CONTROL).unwrap(), "no-cache");
        assert_eq!(archive.headers().get(header::CACHE_CONTROL).unwrap(), "no-cache");
        assert_eq!(not_found.headers().get(header::CACHE_CONTROL).unwrap(), "no-cache");
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

    #[test]
    fn content_type_for_binary_assets_is_never_text_html() {
        assert_eq!(content_type_for("logo.png"), "image/png");
        assert_eq!(content_type_for("mod.wasm"), "application/wasm");
        assert_eq!(content_type_for("font.woff2"), "font/woff2");
        assert_eq!(content_type_for("bundle.js.map"), "application/json");
        // An extension neither the explicit table nor tauri_utils knows must
        // fall back to octet-stream, NOT the misleading text/html.
        assert_eq!(content_type_for("data.bin.xyz"), "application/octet-stream");
    }

    #[test]
    fn csp_drops_a_non_hostname_domain_instead_of_injecting() {
        // A domain smuggling a CSP separator (space/`;`) or CR/LF must not
        // reach the header — is_bare_hostname rejects it and csp_for skips it.
        let json = r#"{"id":"d","capabilities":[{"kind":"net","domains":["a.com; frame-src *","evil\r\nX: 1"]}]}"#;
        let csp = csp_for(json);
        assert!(!csp.contains("frame-src"));
        assert!(!csp.contains('\r') && !csp.contains('\n'));
        assert!(csp.contains("connect-src 'self'"));
    }

    #[test]
    fn respond_never_panics_on_a_hostile_csp() {
        // Even if a bad CSP string reached respond directly, the fallible
        // build must degrade, not panic the webview.
        let resp = respond(
            "tauri://localhost",
            StatusCode::OK,
            Some("connect-src \r\n bad"),
            Some("text/html"),
            b"<p>x</p>".to_vec(),
        );
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[test]
    fn a_forged_trailing_eocd_does_not_desync_the_entry_count() {
        // The declared-count finder must return the TRUE central-directory
        // count, ignoring a forged EOCD appended after the real one whose
        // offset doesn't point at a real CD header — the exact desync that
        // would let a duplicate-entry container pass the `declared vs
        // deduplicated` guard. It must also select the same EOCD the `zip`
        // crate does, so a valid container with trailing junk still reads.
        let root = temp_root();
        let entries = valid_container_entries("demo.forged");
        let path = root.join("demo.kdplugin");
        write_container(&path, &entries);
        let real_count = eocd_declared_entries(&path).unwrap();
        assert_eq!(real_count as usize, entries.len());

        let mut bytes = fs::read(&path).unwrap();
        // A forged EOCD claiming a DIFFERENT entry count, its comment sized
        // to reach EOF, but its CD offset pointing past the file (no CDFH).
        let mut fake = vec![0x50, 0x4b, 0x05, 0x06];
        fake.extend_from_slice(&[0u8; 2]); // this disk
        fake.extend_from_slice(&[0u8; 2]); // cd start disk
        fake.extend_from_slice(&999u16.to_le_bytes()); // entries this disk
        fake.extend_from_slice(&999u16.to_le_bytes()); // total entries (the lie)
        fake.extend_from_slice(&[0u8; 4]); // cd size
        fake.extend_from_slice(&0xffff_ff00u32.to_le_bytes()); // bogus offset
        fake.extend_from_slice(&[0u8, 0u8]); // comment length 0
        bytes.extend_from_slice(&fake);
        fs::write(&path, &bytes).unwrap();

        // The finder ignores the forged record and reports the real count.
        assert_eq!(eocd_declared_entries(&path).unwrap(), real_count);
        // And the container still validates and serves (crate agrees).
        assert!(resolve(&root, "demo.forged").is_some());
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

