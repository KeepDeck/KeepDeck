import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkLayout } from "./check-plugin-bundles.mjs";

const CHECKER = new URL("./check-plugin-bundles.mjs", import.meta.url).href;

// The check runs on the real dist/ as the last step of `pnpm build`. Here it
// runs on a hand-laid one: two built-ins whose folders sort against their ids,
// one with a stylesheet, one with resources a level deep, and the dist/ a sound
// build writes for them. Each test breaks one thing and expects its problem.
let root;

function write(path, text) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

const manifest = (id) =>
  JSON.stringify({ id, name: id, version: "0.0.1", minApiVersion: 1, capabilities: [] });
const ALPHA = { id: "fixture.alpha", dir: "plugins/fixture.alpha", css: true };
const BETA = { id: "fixture.beta", dir: "plugins/fixture.beta" };
const writeIndex = (plugins) => write("dist/plugins/index.json", JSON.stringify({ plugins }));

function layOutSoundBuild() {
  write("plugins/zz-styled/manifest.json", manifest(ALPHA.id));
  write("plugins/aa-hooked/manifest.json", manifest(BETA.id));
  write("plugins/aa-hooked/resources/hook.sh", "#!/bin/sh\necho bound\n");
  write("plugins/aa-hooked/resources/skills/team/SKILL.md", "# team\n");

  write("dist/index.html", '<script type="importmap">{"imports":{"react":"/assets/react.js"}}</script>');
  write("dist/assets/react.js", "export const useState = () => {};\nexport default {};\n");
  writeIndex([ALPHA, BETA]);
  write("dist/plugins/fixture.alpha/index.js", 'import { useState } from "react";\nexport default { useState };\n');
  write("dist/plugins/fixture.alpha/index.css", ".alpha {}\n");
  write("dist/plugins/fixture.alpha/manifest.json", manifest(ALPHA.id));
  write("dist/plugins/fixture.beta/index.js", "export default {};\n");
  write("dist/plugins/fixture.beta/manifest.json", manifest(BETA.id));
  write("dist/plugins/fixture.beta/resources/hook.sh", "#!/bin/sh\necho bound\n");
  write("dist/plugins/fixture.beta/resources/skills/team/SKILL.md", "# team\n");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "kd-bundle-check-"));
  layOutSoundBuild();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("checkLayout", () => {
  const check = () => checkLayout(join(root, "dist"), join(root, "plugins"));
  const remove = (path) => rmSync(join(root, path));

  it("passes a build that lays every built-in out as the host loads it", () => {
    expect(check()).toEqual([ALPHA, BETA]);
  });

  it.each([
    ["a built-in the index leaves out", () => writeIndex([ALPHA]),
      "index.json lists [fixture.alpha], not the built-ins in id order [fixture.alpha, fixture.beta]"],
    ["an index out of id order", () => writeIndex([BETA, ALPHA]),
      "index.json lists [fixture.beta, fixture.alpha]"],
    ["a plugin listed under another directory", () => writeIndex([ALPHA, { ...BETA, dir: "plugins/beta" }]),
      "fixture.beta: listed under plugins/beta, not plugins/fixture.beta"],
    ["a worker chunk emitted beside index.js", () => write("dist/plugins/fixture.alpha/worker-3f2a.js", ""),
      "fixture.alpha: the host never loads worker-3f2a.js: it imports index.js alone"],
    ["a stylesheet the index does not flag", () => writeIndex([{ ...ALPHA, css: undefined }, BETA]),
      "fixture.alpha: css flag unset, but index.css landed"],
    ["a flag with no stylesheet behind it", () => remove("dist/plugins/fixture.alpha/index.css"),
      "fixture.alpha: css flag set, but index.css is missing"],
    ["a manifest that is not the source's", () => write("dist/plugins/fixture.alpha/manifest.json", manifest("fixture.other")),
      "fixture.alpha: manifest.json is not"],
    ["a resource left behind", () => remove("dist/plugins/fixture.beta/resources/skills/team/SKILL.md"),
      "fixture.beta: resources differ from"],
    ["a resource changed on the way", () => appendFileSync(join(root, "dist/plugins/fixture.beta/resources/hook.sh"), "exit 1\n"),
      "'s at hook.sh"],
    ["a resource the source does not ship", () => write("dist/plugins/fixture.beta/resources/stale.js", ""),
      "'s at stale.js"],
    ["a bundle that carries its own React", () => appendFileSync(join(root, "dist/plugins/fixture.beta/index.js"), 'Symbol.for("react.transitional.element");\n'),
      "fixture.beta: index.js carries its own React"],
    ["a plugin without its bundle", () => remove("dist/plugins/fixture.beta/index.js"),
      "fixture.beta: no index.js"],
  ])("refuses %s", (_, breakIt, problem) => {
    breakIt();
    expect(check).toThrow(problem);
  });

  it("names the nested resource that went missing by its path", () => {
    remove("dist/plugins/fixture.beta/resources/skills/team/SKILL.md");
    expect(check).toThrow("'s at skills/team/SKILL.md");
  });

  it("lists every problem of a build in one go", () => {
    write("dist/plugins/fixture.alpha/worker-3f2a.js", "");
    remove("dist/plugins/fixture.beta/index.js");
    expect(check).toThrow(/never loads worker-3f2a\.js[\s\S]*fixture\.beta: no index\.js/);
  });
});

describe("linkPlugins", () => {
  // Linking needs node:vm's SourceTextModule, which only a process started
  // with --experimental-vm-modules has: one child links all three dists.
  const DRIVER = `
    const { linkPlugins } = await import(${JSON.stringify(CHECKER)});
    const { createContext } = await import("node:vm");
    for (const dist of process.argv.slice(1)) {
      try {
        console.log(JSON.stringify((await linkPlugins(dist, createContext())).linked));
      } catch (error) {
        console.log(error.message);
      }
    }`;

  it("links every bundle through the import map, and refuses a specifier the map lacks or an export the target lacks", () => {
    const sound = join(root, "dist");
    const variant = (name, bundle) => {
      const dist = join(root, name);
      write(`${name}/index.html`, readFileSync(join(sound, "index.html"), "utf8"));
      write(`${name}/assets/react.js`, readFileSync(join(sound, "assets/react.js"), "utf8"));
      write(`${name}/plugins/index.json`, JSON.stringify({ plugins: [BETA] }));
      write(`${name}/plugins/fixture.beta/index.js`, bundle);
      return dist;
    };
    const unmapped = variant("unmapped", 'import { createPortal } from "react-dom";\nexport default { createPortal };\n');
    // The shape of the flushSync regression: the specifier maps, the name the
    // bundle imports is not among the bridge's exports.
    const unexported = variant("unexported", 'import { useSyncExternalStore } from "react";\nexport default { useSyncExternalStore };\n');

    const out = execFileSync(
      process.execPath,
      ["--experimental-vm-modules", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", DRIVER, sound, unmapped, unexported],
      { encoding: "utf8" },
    );

    expect(out.trim().split("\n")).toEqual([
      JSON.stringify([ALPHA.id, BETA.id]),
      `${join(unmapped, "plugins/fixture.beta/index.js")}: no import-map entry for react-dom`,
      expect.stringContaining("does not provide an export named 'useSyncExternalStore'"),
    ]);
  });
});
