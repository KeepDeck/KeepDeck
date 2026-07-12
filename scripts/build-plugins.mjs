#!/usr/bin/env node
// Builds every built-in plugin under plugins/<dir>/ into its own standalone
// ESM bundle — never glued into the app bundle — that the host loads at
// runtime via dynamic import() plus the import map declared in index.html.
// Every plugin bundle marks react, react/jsx-runtime, react-dom,
// react-dom/client, and @keepdeck/plugin-api EXTERNAL: the host supplies all
// five at runtime via
// the bridge chunks built from src/plugins/bridges/ (see vite.config.ts), so
// a plugin never bundles its own React and never renders with a second,
// unsynchronized copy sitting next to the host's.
//
// For every plugins/*/ directory carrying a manifest.json: validate it with
// the SAME `readManifest` the host runs at load time (a malformed manifest
// fails the build here, loudly, with every problem listed — not silently at
// runtime), Vite-build the plugin's src/index.ts(x) in lib mode to
// <dist>/plugins/<manifest id>/index.js, copy the manifest alongside it, then
// write <dist>/plugins/index.json — the single file the host reads to
// discover what's installed — with entries sorted by id so the file's diff
// is stable across builds regardless of directory-scan order.
//
// A plugin OWNS its CSS: any stylesheet its module graph imports is emitted
// by the lib build as <dist>/plugins/<id>/index.css (the fixed name matters —
// the host can't chase a hash), and the plugin's index.json entry is flagged
// `css: true` so the production loader links the file alongside the module
// import. Dev needs none of this: plugins load from source and Vite injects
// their styles on import.
//
// Runs AFTER `vite build` in the "build" script (see package.json): the app
// build's `emptyOutDir` would otherwise wipe whatever this script wrote.
// Conversely, this script only ever touches <dist>/plugins/ — dist/ may not
// exist yet on a fresh checkout, or may already hold the app build; neither
// case is this script's concern.
//
// Output root is overridable via --out-dir <path> or the KEEPDECK_PLUGINS_OUT
// env var (argv wins), so tests can point the whole pipeline at a scratch
// directory instead of the real dist/.

import { build } from "vite";
import { readManifest } from "@keepdeck/plugin-api";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PLUGINS_ROOT = "plugins";
const DEFAULT_DIST_ROOT = "dist";
const ENTRY_NAMES = ["index.ts", "index.tsx"];
// The host's bridge chunks (src/plugins/bridges/) stand in for all five at
// runtime — see the file header above.
const EXTERNAL = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@keepdeck/plugin-api",
];

export function resolveDistRoot(argv = process.argv.slice(2), env = process.env) {
  const i = argv.indexOf("--out-dir");
  if (i !== -1) {
    const dir = argv[i + 1];
    if (!dir) throw new Error("--out-dir needs a path");
    return dir;
  }
  return env.KEEPDECK_PLUGINS_OUT ?? DEFAULT_DIST_ROOT;
}

/** Every plugins/<name> directory that carries a manifest.json — the
 * pipeline's unit of work. Sorted by directory name so build order (and
 * hence build log order) is stable; index.json's own order is sorted by
 * manifest id separately, since a folder name need not match its id. */
export function findPluginDirs(pluginsRoot = PLUGINS_ROOT) {
  if (!existsSync(pluginsRoot)) return [];
  return readdirSync(pluginsRoot)
    .map((name) => join(pluginsRoot, name))
    .filter(
      (dir) => statSync(dir).isDirectory() && existsSync(join(dir, "manifest.json")),
    )
    .sort();
}

/** src/index.ts or src/index.tsx — whichever the plugin ships. */
export function findEntry(pluginDir) {
  for (const name of ENTRY_NAMES) {
    const entry = join(pluginDir, "src", name);
    if (existsSync(entry)) return entry;
  }
  throw new Error(`${pluginDir}: no src/index.ts or src/index.tsx found`);
}

/** Read and validate a plugin's manifest with the host's own validator —
 * fails loudly, listing every problem, so a broken manifest never reaches a
 * real user as a silent runtime rejection. */
export function validateManifest(pluginDir) {
  const manifestPath = join(pluginDir, "manifest.json");
  const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  const result = readManifest(raw);
  if (!result.ok) {
    const problems = result.errors.map((e) => `  - ${e}`).join("\n");
    throw new Error(`${manifestPath}: invalid manifest\n${problems}`);
  }
  return result.manifest;
}

async function buildOne(pluginDir, distRoot) {
  const manifest = validateManifest(pluginDir);
  const entry = findEntry(pluginDir);
  const outDir = resolve(join(distRoot, "plugins", manifest.id));

  // Vite only defaults process.env.NODE_ENV to "production" for a build when
  // it isn't ALREADY set — and it usually already is, e.g. to "test" when
  // this script runs as a subprocess of the vitest suite. Left alone, that
  // flips Vite's internal isProduction flag to false, which flips esbuild's
  // automatic-JSX-runtime output to `jsxDEV`/"react/jsx-dev-runtime" instead
  // of `jsx`/"react/jsx-runtime" — a specifier this script does NOT mark
  // external, so react's entire development bundle silently inlines into
  // what must be a slim, externalized plugin bundle. A shipped plugin bundle
  // is always a production build. Save/restore around the build so an
  // in-process caller doesn't have NODE_ENV flipped out from under it.
  const priorNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await buildPluginBundle(entry, outDir);
  } finally {
    if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = priorNodeEnv;
  }

  cpSync(join(pluginDir, "manifest.json"), join(outDir, "manifest.json"));
  // Bundle resources (reporter scripts a spawned CLI must open from disk) —
  // shipped verbatim under <out>/resources/, resolved via ctx.resources.path.
  const resources = join(pluginDir, "resources");
  if (existsSync(resources)) {
    cpSync(resources, join(outDir, "resources"), { recursive: true });
  }
  // Whether the build emitted the plugin's stylesheet — the OUTPUT is the
  // ground truth (not a manifest claim), so the flag can never point the
  // loader at a file that isn't there.
  const css = existsSync(join(outDir, "index.css"));
  console.log(`  built ${manifest.id}  (${pluginDir} -> ${join(distRoot, "plugins", manifest.id)})`);
  return { id: manifest.id, css };
}

async function buildPluginBundle(entry, outDir) {
  await build({
    root: process.cwd(),
    // Never let this pick up the HOST's vite.config.ts (its `build.rollupOptions`
    // is a fixed multi-entry app build, entirely unrelated to a plugin's lib build).
    configFile: false,
    logLevel: "warn",
    build: {
      outDir,
      // Safe even for an outDir outside the repo (a test's tmp dir): passing
      // `true` explicitly skips Vite's "outside project root" auto-detection,
      // which only kicks in when this is left unset.
      emptyOutDir: true,
      lib: {
        entry: resolve(entry),
        formats: ["es"],
        fileName: () => "index.js",
        // CSS imported anywhere in the plugin's module graph lands here, next
        // to index.js, under a name the loader can compute.
        cssFileName: "index",
      },
      rollupOptions: { external: EXTERNAL },
    },
  });
}

function writeIndex(distRoot, built) {
  const dir = join(distRoot, "plugins");
  mkdirSync(dir, { recursive: true });
  const plugins = [...built]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(({ id, css }) => ({
      id,
      dir: `plugins/${id}`,
      // Present only when true — an entry without CSS stays the shape it
      // always was, so the file's diff shows exactly which plugins gained one.
      ...(css ? { css: true } : {}),
    }));
  writeFileSync(join(dir, "index.json"), JSON.stringify({ plugins }, null, 2) + "\n");
  return join(dir, "index.json");
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  const distRoot = resolveDistRoot(argv, env);
  const pluginDirs = findPluginDirs();

  if (pluginDirs.length === 0) {
    console.log("No plugins found under plugins/; nothing to build.");
    writeIndex(distRoot, []);
    return [];
  }

  console.log(`Building ${pluginDirs.length} plugin(s)...`);
  const built = [];
  for (const dir of pluginDirs) {
    built.push(await buildOne(dir, distRoot));
  }

  const indexPath = writeIndex(distRoot, built);
  console.log(`Wrote ${indexPath}`);
  return built.map(({ id }) => id);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
