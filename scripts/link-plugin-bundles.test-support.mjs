// Run under node --experimental-vm-modules. Link the production ESM graph
// without evaluating it: Tauri/DOM runtime services are irrelevant to whether
// the host's import map supplies every binding a built plugin imports.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SourceTextModule } from "node:vm";

const distRoot = resolve(process.argv[2]);
const html = readFileSync(resolve(distRoot, "index.html"), "utf8");
const importMap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
assert.ok(importMap, "Built index.html must contain the plugin import map");
const { imports } = JSON.parse(importMap[1]);
const { plugins } = JSON.parse(
  readFileSync(resolve(distRoot, "plugins/index.json"), "utf8"),
);
const modules = new Map();

function moduleAt(path) {
  if (!modules.has(path)) {
    modules.set(path, new SourceTextModule(readFileSync(path, "utf8"), {
      identifier: path,
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

for (const { id, dir } of plugins) {
  const entry = moduleAt(resolve(distRoot, dir, "index.js"));
  await entry.link(link);
  assert.equal(entry.status, "linked");
  console.log(`Linked ${id}`);
}
