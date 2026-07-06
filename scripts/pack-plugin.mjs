#!/usr/bin/env node
// Packs an external-plugin folder into a `.kdplugin` container — the ONLY
// blessed writer of the format, and therefore its reference implementation
// (docs/plugin-container.md is the prose spec; disagreements resolve in favor
// of this file). Usage:
//
//   node scripts/pack-plugin.mjs <plugin-dir> [-o <out.kdplugin>]
//
// The container is a plain STORED zip (no compression): plugin bundles are
// small, `unzip -l` stays a working inspection tool, and a stored archive is
// byte-deterministic — same input tree, same output file — because entry
// order is sorted and timestamps are pinned. `container.json` (the format
// version marker) is synthesized by the packer, never taken from the tree:
// the packer owns packaging metadata, authors own plugin content.
//
// Validation happens before a single byte is written, and mirrors what the
// app's reader enforces: a container that packs here loads there.

import { readManifest } from "@keepdeck/plugin-api";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The container-format revision this packer writes. Readers refuse a HIGHER
 * format with "created by a newer KeepDeck"; additions that older readers can
 * ignore do not bump it, layout/meaning changes do. */
export const CONTAINER_FORMAT = 1;

/** Zip-bomb / abuse guards — enforced by the reader too, so packing beyond
 * them would only produce a container that refuses to load. */
export const MAX_ENTRIES = 1000;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/** Entry names the packer owns; a plugin tree must not carry its own. */
const RESERVED = new Set(["container.json", "SIGNATURE"]);

/**
 * Walk the plugin tree and validate it against the container rules. Returns
 * the manifest and the flat file list (paths relative, forward slashes,
 * sorted). Throws with EVERY problem listed — an author fixes one round.
 */
export function validatePluginDir(dir) {
  const problems = [];
  const files = [];
  walk(dir, "", files, problems);

  const manifestEntry = files.find((f) => f.rel === "manifest.json");
  let manifest = null;
  if (!manifestEntry) {
    problems.push("manifest.json: required at the plugin root");
  } else {
    try {
      const result = readManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")));
      if (result.ok) manifest = result.manifest;
      else problems.push(...result.errors.map((e) => `manifest.json: ${e}`));
    } catch (e) {
      problems.push(`manifest.json: not valid JSON (${e.message})`);
    }
  }

  // Every declared dock tab must ship its document — a tab that 404s at
  // runtime is an authoring error this tool exists to catch early.
  for (const tab of manifest?.contributes.dockTabs ?? []) {
    if (!files.some((f) => f.rel === `${tab.id}.html`)) {
      problems.push(`contributes.dockTabs["${tab.id}"]: missing ${tab.id}.html`);
    }
  }
  // Every plugin is code: its entry is `main.js` at the root (fixed
  // convention, no manifest field). A tree without one would install but
  // never activate — the realm's module 404s — so catch it here.
  if (manifest && !files.some((f) => f.rel === "main.js")) {
    problems.push("main.js: required at the plugin root (the entry the realm runs)");
  }

  for (const f of files) {
    if (RESERVED.has(f.rel)) {
      problems.push(`${f.rel}: reserved — written by the packer, remove it from the tree`);
    }
    if (f.size > MAX_FILE_BYTES) {
      problems.push(`${f.rel}: ${f.size} bytes exceeds the ${MAX_FILE_BYTES} per-file cap`);
    }
  }
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_TOTAL_BYTES) {
    problems.push(`tree totals ${total} bytes, over the ${MAX_TOTAL_BYTES} cap`);
  }
  if (files.length + 1 > MAX_ENTRIES) {
    problems.push(`${files.length} files, over the ${MAX_ENTRIES}-entry cap`);
  }

  if (problems.length > 0) {
    throw new Error(`not a valid plugin tree:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  return { manifest, files };
}

function walk(root, rel, files, problems) {
  for (const name of readdirSync(join(root, rel))) {
    // Dotfiles are tooling residue (.DS_Store, .git), never plugin content.
    if (name.startsWith(".")) continue;
    if (name.includes("\\")) {
      problems.push(`${join(rel, name)}: backslash in a name — forward slashes only`);
      continue;
    }
    // A drive-letter-shaped name (`c:foo`) is rejected by the app's reader —
    // pack it and the whole container goes invisible at install. Catch it
    // here so "packs here, loads there" holds.
    if (/^[a-zA-Z]:/.test(name)) {
      problems.push(`${join(rel, name)}: drive-letter name — not allowed in a container`);
      continue;
    }
    const relPath = rel ? `${rel}/${name}` : name;
    const full = join(root, relPath);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      // A symlink’s target escapes the tree at read time — the reader bans
      // them, so packing one would be a delayed failure.
      problems.push(`${relPath}: symlink — not allowed in a container`);
    } else if (stat.isDirectory()) {
      walk(root, relPath, files, problems);
    } else {
      files.push({ rel: relPath, size: stat.size });
    }
  }
}

/** Build the container bytes: container.json first, then the tree, stored,
 * sorted, timestamps pinned — byte-identical for identical input. */
export function buildContainer(dir, files) {
  const entries = [
    {
      rel: "container.json",
      data: Buffer.from(JSON.stringify({ format: CONTAINER_FORMAT }) + "\n"),
    },
    ...files.map((f) => ({ rel: f.rel, data: readFileSync(join(dir, f.rel)) })),
  ];
  return writeStoredZip(entries);
}

export async function run(argv = process.argv.slice(2)) {
  if (argv.includes("--help") || argv.length === 0) {
    console.log(
      "Usage: node scripts/pack-plugin.mjs <plugin-dir> [-o <out.kdplugin>]\n" +
        "Validates the tree and writes a .kdplugin container.\n" +
        "Format spec + authoring guide: docs/plugin-container.md",
    );
    return null;
  }
  const oFlag = argv.indexOf("-o");
  if (oFlag !== -1 && !argv[oFlag + 1]) throw new Error("-o needs a path");
  // The plugin dir is the first NON-flag argument, so `-o` can lead.
  const dirArg = argv.find((a, i) => a !== "-o" && argv[i - 1] !== "-o");
  if (!dirArg) throw new Error("no plugin directory given");
  const dir = resolve(dirArg);
  const { manifest, files } = validatePluginDir(dir);
  const out =
    oFlag !== -1 ? argv[oFlag + 1] : `${sanitizeFileName(manifest.name)}.kdplugin`;
  writeFileSync(out, buildContainer(dir, files));
  console.log(`packed ${manifest.id} ${manifest.version} (${files.length + 1} entries) -> ${out}`);
  return out;
}

/** The default output name comes from the plugin's display name — cosmetic,
 * like install-folder names; identity stays inside the manifest. */
function sanitizeFileName(name) {
  return name.replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "plugin";
}

// ------------------------------------------------------------ zip writing
// A minimal STORED-only zip writer: local headers + central directory + EOCD.
// Hand-rolled on purpose — node has no zip in std, the repo takes no dep for
// one fixed, tiny format, and store-only keeps it ~80 lines and deterministic.

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (2026 - 1980) << 9 | (1 << 5) | 1; // 2026-01-01, pinned

function writeStoredZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { rel, data } of entries) {
    const name = Buffer.from(rel, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central header signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // extra, comment, disk, internal attrs, external attrs: all zero
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + data.length;
  }
  const centralStart = offset;
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
