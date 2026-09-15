// Run under node --experimental-vm-modules. Link every production plugin,
// then render Git through the same built host bridges in a DOM realm without
// Node's process, Buffer or require.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { dirname, resolve } from "node:path";
import { SourceTextModule, runInContext } from "node:vm";
import { Window } from "happy-dom";
import { checkGitRender } from "./render-git-plugin.test-support.mjs";

const distRoot = resolve(process.argv[2]);
const html = readFileSync(resolve(distRoot, "index.html"), "utf8");
const importMap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
assert.ok(importMap, "Built index.html must contain the plugin import map");
const { imports } = JSON.parse(importMap[1]);
const { plugins } = JSON.parse(
  readFileSync(resolve(distRoot, "plugins/index.json"), "utf8"),
);
const window = new Window({ url: "http://keepdeck.test" });
// Happy DOM exposes Node's Buffer on Window; the real webview does not.
delete window.Buffer;
for (const name of ["process", "Buffer", "require"]) {
  assert.equal(runInContext(`typeof ${name}`, window), "undefined");
}
const modules = new Map();

function moduleAt(path) {
  if (!modules.has(path)) {
    modules.set(path, new SourceTextModule(readFileSync(path, "utf8"), {
      identifier: path,
      context: window,
    }));
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

try {
  for (const { id, dir } of plugins) {
    const entry = moduleAt(resolve(distRoot, dir, "index.js"));
    await entry.link(link);
    assert.equal(entry.status, "linked");
    console.log(`Linked ${id}`);
  }

  // Reuse the UI kit's layout stand in this realm; only test support is
  // stripped from TS. The plugin and all its dependencies stay built JS.
  const geometry = new SourceTextModule(stripTypeScriptTypes(readFileSync(
    new URL("../packages/ui-kit/src/virtualGeometry.test-support.ts", import.meta.url),
    "utf8",
  )), { context: window });
  const bridge = (name) => evaluate(link(name, { identifier: resolve(distRoot, "index.html") }));
  await checkGitRender({
    window,
    plugin: (await evaluate(moduleAt(resolve(distRoot, "plugins/keepdeck.git/index.js")))).default,
    react: await bridge("react"),
    reactDom: await bridge("react-dom"),
    reactDomClient: await bridge("react-dom/client"),
    geometry: await evaluate(geometry),
  });
  console.log("Rendered keepdeck.git changes and history without Node globals");
} finally {
  await window.happyDOM.close();
}
