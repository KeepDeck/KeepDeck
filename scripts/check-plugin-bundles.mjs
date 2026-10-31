#!/usr/bin/env node
// The last step of `pnpm build` (see package.json): proves the dist/ the build
// just wrote — the one the app ships — is one the host can load, with every
// plugin as it left plugins/. Run under node --experimental-vm-modules with the
// dist root as its argument.
//
// For every built-in plugin (a plugins/<dir> with a manifest, the build's own
// unit of work):
// - index.json lists it under plugins/<id>, in id order, flagged `css` exactly
//   where index.css landed: the loader links what the flag says;
// - its directory holds index.js and its manifest, its stylesheet and
//   resources when it has them, and nothing else: the host imports index.js
//   alone, so a chunk emitted beside it (a worker imported without `&inline`)
//   never loads;
// - the manifest and every resource arrived byte for byte;
// - index.js carries no React of its own: the host's bridges supply it, and a
//   second copy breaks every hook that crosses the two;
// - index.js links through the built index.html's import map, against the
//   bridges' real exports.
// Then Git renders through those bridges in a DOM realm without Node's
// process, Buffer or require, which source tests all have.
//
// scripts/check-plugin-bundles.test.mjs holds each rule to a red.

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
// Read off the module when linking: SourceTextModule exists only under
// --experimental-vm-modules, and the file rules need no flag.
import vm from "node:vm";
import { findPluginDirs, validateManifest } from "./build-plugins.mjs";

/** What a plugin's directory may hold — see the header. This is
 * build-plugins.mjs's output contract, restated on purpose: the check pins
 * what the build writes, so it cannot read it from the build. */
const PLUGIN_FILES = ["index.js", "index.css", "manifest.json", "resources"];
/** React's element tag. Only React's own code spells it, so a bundle that
 * carries it inlined React instead of importing the host's. */
const OWN_REACT = "react.transitional.element";

function readIndex(distRoot) {
  return JSON.parse(readFileSync(join(distRoot, "plugins", "index.json"), "utf8")).plugins;
}

/** Every file under `root`, by its path relative to it. */
function filesUnder(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)));
}

function sameBytes(a, b) {
  return existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));
}

/** The paths where two trees differ: missing from either, or changed. */
function treeDifferences(source, built) {
  return [...new Set([...filesUnder(source), ...filesUnder(built)])]
    .sort()
    .filter((path) => !sameBytes(join(source, path), join(built, path)));
}

/** Every rule but linking, read off the files. Collects EVERY problem, as the
 * manifest check does, so one failed build lists them all. Returns the
 * entries index.json lists. */
export function checkLayout(distRoot, pluginsRoot = "plugins") {
  const sources = new Map(
    findPluginDirs(pluginsRoot).map((dir) => [validateManifest(dir).id, dir]),
  );
  const plugins = readIndex(distRoot);
  const problems = [];

  const listed = plugins.map(({ id }) => id);
  const builtIns = [...sources.keys()].sort();
  if (JSON.stringify(listed) !== JSON.stringify(builtIns)) {
    problems.push(
      `index.json lists [${listed.join(", ")}], not the built-ins in id order [${builtIns.join(", ")}]`,
    );
  }

  for (const { id, dir, css } of plugins) {
    const source = sources.get(id);
    // An entry that is no built-in is already named above.
    if (!source) continue;
    if (dir !== `plugins/${id}`) {
      problems.push(`${id}: listed under ${dir}, not plugins/${id}`);
      continue;
    }
    const out = join(distRoot, dir);
    if (!existsSync(out)) {
      problems.push(`${id}: nothing at ${dir}`);
      continue;
    }

    const present = readdirSync(out);
    const strays = present.filter((name) => !PLUGIN_FILES.includes(name));
    if (strays.length > 0) {
      problems.push(`${id}: the host never loads ${strays.join(", ")}: it imports index.js alone`);
    }
    const styled = present.includes("index.css");
    if ((css === true) !== styled) {
      problems.push(
        `${id}: css flag ${css === true ? "set" : "unset"}, but index.css ${styled ? "landed" : "is missing"}`,
      );
    }
    if (!sameBytes(join(source, "manifest.json"), join(out, "manifest.json"))) {
      problems.push(`${id}: manifest.json is not ${source}'s`);
    }
    const resources = treeDifferences(join(source, "resources"), join(out, "resources"));
    if (resources.length > 0) {
      problems.push(`${id}: resources differ from ${source}'s at ${resources.join(", ")}`);
    }
    if (!present.includes("index.js")) problems.push(`${id}: no index.js`);
    else if (readFileSync(join(out, "index.js"), "utf8").includes(OWN_REACT)) {
      problems.push(`${id}: index.js carries its own React instead of importing the host's`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `${distRoot}: not a build the host can load\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
  return plugins;
}

/** Link every plugin index.json lists, in `context`, through the built
 * index.html's import map — the resolution the webview does. Linking checks
 * each import against the target's real exports and runs no plugin code.
 * Returns the ids linked, and a loader over the same modules for a caller that
 * goes on to evaluate them. */
export async function linkPlugins(distRoot, context) {
  const html = readFileSync(resolve(distRoot, "index.html"), "utf8");
  const importMap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  assert.ok(importMap, "Built index.html must contain the plugin import map");
  const { imports } = JSON.parse(importMap[1]);
  const modules = new Map();

  function moduleAt(path) {
    if (!modules.has(path)) {
      modules.set(path, new vm.SourceTextModule(readFileSync(path, "utf8"), { identifier: path, context }));
    }
    return modules.get(path);
  }

  function link(specifier, referrer) {
    const target = imports[specifier] ?? specifier;
    assert.ok(
      target.startsWith("/") || target.startsWith("."),
      `${referrer.identifier}: no import-map entry for ${specifier}`,
    );
    return moduleAt(target.startsWith("/")
      ? resolve(distRoot, target.slice(1))
      : resolve(dirname(referrer.identifier), target));
  }

  async function evaluate(module) {
    if (module.status === "unlinked") await module.link(link);
    await module.evaluate();
    return module.namespace;
  }

  const linked = [];
  for (const { id, dir } of readIndex(distRoot)) {
    await moduleAt(resolve(distRoot, dir, "index.js")).link(link);
    linked.push(id);
  }
  return {
    linked,
    evaluate,
    plugin: (id) => evaluate(moduleAt(resolve(distRoot, "plugins", id, "index.js"))),
    bridge: (specifier) => evaluate(link(specifier, { identifier: resolve(distRoot, "index.html") })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const distRoot = resolve(process.argv[2]);
  checkLayout(distRoot);

  // The render alone needs a DOM, so only the build step loads one.
  const { Window } = await import("happy-dom");
  const { checkGitRender } = await import("./render-git-plugin.mjs");
  const window = new Window({ url: "http://keepdeck.test" });
  // Happy DOM exposes Node's Buffer on Window; the real webview does not.
  delete window.Buffer;
  try {
    for (const name of ["process", "Buffer", "require"]) {
      assert.equal(vm.runInContext(`typeof ${name}`, window), "undefined");
    }
    const realm = await linkPlugins(distRoot, window);
    for (const id of realm.linked) console.log(`Linked ${id}`);

    // Reuse the UI kit's layout stand in this realm; only test support is
    // stripped from TS. The plugin and all its dependencies stay built JS.
    const geometry = new vm.SourceTextModule(stripTypeScriptTypes(readFileSync(
      new URL("../packages/ui-kit/src/virtualGeometry.test-support.ts", import.meta.url),
      "utf8",
    )), { context: window });
    await checkGitRender({
      window,
      plugin: (await realm.plugin("keepdeck.git")).default,
      react: await realm.bridge("react"),
      reactDom: await realm.bridge("react-dom"),
      reactDomClient: await realm.bridge("react-dom/client"),
      geometry: await realm.evaluate(geometry),
    });
    console.log("Rendered keepdeck.git changes and history without Node globals");
  } finally {
    await window.happyDOM.close();
  }
}
