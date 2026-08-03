// One editable copy of every reporter script a spawned CLI runs.
//
// The reporters are shipped INSIDE each plugin (`ctx.resources.path` resolves
// them under `plugins/<id>/resources/`, and kimi's companion directory is
// copied wholesale onto the user's machine), so the same script has to exist
// as a real file in several places. Nothing about that requires it to be
// AUTHORED several times: the canonical text lives once under
// resources/reporters/ and this script writes the copies.
//
// Why copies rather than a symlink or a runtime `.`-include: the resource
// resolver canonicalizes, dev reads the source tree while a bundle reads
// Resources/, and kimi's companion is copied as a directory by a third path —
// three different packaging semantics that all keep working if, and only if,
// every destination is an ordinary file. So the duplication moves from the
// author to the build, where a test can hold it.
//
// `node scripts/sync-reporters.mjs` rewrites the copies; `--check` reports
// stale ones without touching disk (what sync-reporters.test.mjs runs).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CANONICAL_DIR = join(ROOT, "resources", "reporters");

/** Canonical script -> every plugin resource directory that ships it. */
export const REPORTERS = [
  {
    name: "kd-session-hook.sh",
    destinations: [
      "plugins/claude/resources",
      "plugins/codex/resources",
      "plugins/kimi/resources/keepdeck-session-reporter",
    ],
  },
  {
    name: "kd-status-hook.sh",
    destinations: [
      "plugins/claude/resources",
      "plugins/codex/resources",
      "plugins/kimi/resources/keepdeck-session-reporter",
    ],
  },
  {
    name: "kd-usage-statusline.sh",
    destinations: ["plugins/claude/resources"],
  },
];

/** The banner a copy carries and the canonical file does not — it is the only
 * difference between them, and it is what a reader who opens the wrong file
 * needs to see first. Sits under the shebang, which must stay line 1. */
function banner(name) {
  return [
    `# GENERATED from resources/reporters/${name} — do not edit this copy.`,
    "# Edit the canonical file and run `node scripts/sync-reporters.mjs`;",
    "# scripts/sync-reporters.test.mjs fails while a copy is stale.",
  ].join("\n");
}

/** Exactly what each destination must contain. */
export function rendered(name) {
  const source = readFileSync(join(CANONICAL_DIR, name), "utf8");
  const newline = source.indexOf("\n");
  if (!source.startsWith("#!") || newline === -1) {
    throw new Error(`${name}: a reporter must open with a shebang line`);
  }
  return `${source.slice(0, newline)}\n${banner(name)}\n${source.slice(newline + 1)}`;
}

/** Destinations whose contents differ from `rendered`, as repo-relative paths. */
export function stale() {
  const out = [];
  for (const { name, destinations } of REPORTERS) {
    const want = rendered(name);
    for (const destination of destinations) {
      const path = join(destination, name);
      let have = null;
      try {
        have = readFileSync(join(ROOT, path), "utf8");
      } catch {
        // Missing counts as stale; the writer creates it.
      }
      if (have !== want) out.push(path);
    }
  }
  return out;
}

function write() {
  for (const { name, destinations } of REPORTERS) {
    const want = rendered(name);
    for (const destination of destinations) {
      writeFileSync(join(ROOT, destination, name), want);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outdated = stale();
  if (process.argv.includes("--check")) {
    if (outdated.length > 0) {
      console.error(`stale reporter copies:\n${outdated.map((p) => `  ${p}`).join("\n")}`);
      process.exit(1);
    }
    console.log("reporter copies are in sync");
  } else {
    write();
    console.log(
      outdated.length > 0
        ? `synced ${outdated.length} reporter cop${outdated.length === 1 ? "y" : "ies"}`
        : "reporter copies were already in sync",
    );
  }
}
