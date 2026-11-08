#!/usr/bin/env node
// Builds the Tauri updater manifest (latest.json) for the rolling "latest"
// release: the released version plus, per platform, the payload's download
// URL and the minisign signature the bundler wrote next to it. The installed
// app checks this file to learn whether an update exists, so the publish job
// must upload it AFTER the payloads it points at. Zero dependencies; CI runs
// it via .github/workflows/release.yml, and it works locally the same way.
//
//   node scripts/release-manifest.mjs --version 1.2.3 --repo owner/name \
//     --out latest.json --payload darwin-aarch64=path/to/arm64.app.tar.gz
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { isEntryPoint } from "./lib/entry.mjs";

/**
 * @typedef {{ version: string, repo: string, out: string, payloads: Record<string, string> }} ManifestArgs
 */

/**
 * @param {string[]} argv
 * @returns {ManifestArgs}
 */
export function parseArgs(argv) {
  /** @type {string | undefined} */
  let version;
  /** @type {string | undefined} */
  let repo;
  /** @type {string | undefined} */
  let out;
  /** @type {Record<string, string>} */
  const payloads = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--version") version = argv[++i];
    else if (flag === "--repo") repo = argv[++i];
    else if (flag === "--out") out = argv[++i];
    else if (flag === "--payload") {
      const pair = argv[++i] ?? "";
      const eq = pair.indexOf("=");
      if (eq < 1) {
        throw new Error(`--payload expects <platform>=<file>, got: ${pair}`);
      }
      payloads[pair.slice(0, eq)] = pair.slice(eq + 1);
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!version) throw new Error("--version is required");
  if (!repo) throw new Error("--repo is required");
  if (!out) throw new Error("--out is required");
  if (Object.keys(payloads).length === 0) {
    throw new Error("at least one --payload is required");
  }
  return { version, repo, out, payloads };
}

/**
 * @param {{ version: string, repo: string, payloads: Record<string, string> }} args
 * @param {(path: string) => string} [read]
 * @param {() => Date} [now]
 * @returns {{ version: string, pub_date: string, platforms: Record<string, { signature: string, url: string }> }}
 */
export function buildManifest(
  { version, repo, payloads },
  read = (path) => readFileSync(path, "utf8"),
  now = () => new Date(),
) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`unsupported version format: ${version}`);
  }
  /** @type {Record<string, { signature: string, url: string }>} */
  const platforms = {};
  for (const [platform, file] of Object.entries(payloads)) {
    const signature = read(`${file}.sig`).trim();
    if (!signature) throw new Error(`empty signature at ${file}.sig`);
    platforms[platform] = {
      signature,
      // The rolling release is addressed by its literal tag; the
      // /releases/latest/ convenience URL resolves by publish date instead
      // and would break the day any other release exists in the repo.
      url: `https://github.com/${repo}/releases/download/latest/${basename(file)}`,
    };
  }
  return { version, pub_date: now().toISOString(), platforms };
}

/**
 * @param {string[]} [argv]
 */
export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const manifest = buildManifest(args);
  writeFileSync(args.out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `Wrote ${args.out}: ${manifest.version} (${Object.keys(manifest.platforms).join(", ")})`,
  );
  return manifest;
}

if (isEntryPoint(import.meta.url)) {
  main();
}
