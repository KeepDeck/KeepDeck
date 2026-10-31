import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findEntry,
  findPluginDirs,
  resolveDistRoot,
  validateManifest,
} from "./build-plugins.mjs";

const SCRIPT = fileURLToPath(new URL("./build-plugins.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("resolveDistRoot", () => {
  it("defaults to dist/", () => {
    expect(resolveDistRoot([], {})).toBe("dist");
  });

  it("falls back to the env var when no flag is given", () => {
    expect(resolveDistRoot([], { KEEPDECK_PLUGINS_OUT: "/tmp/from-env" })).toBe(
      "/tmp/from-env",
    );
  });

  it("prefers --out-dir over the env var", () => {
    expect(
      resolveDistRoot(["--out-dir", "/tmp/from-flag"], {
        KEEPDECK_PLUGINS_OUT: "/tmp/from-env",
      }),
    ).toBe("/tmp/from-flag");
  });

  it("throws when --out-dir has no value", () => {
    expect(() => resolveDistRoot(["--out-dir"], {})).toThrow(/needs a path/);
  });
});

describe("findPluginDirs", () => {
  it("finds the real run plugin under plugins/", () => {
    expect(findPluginDirs("plugins")).toContain(join("plugins", "run"));
  });

  it("returns an empty list when the plugins root does not exist", () => {
    expect(findPluginDirs("plugins-that-do-not-exist")).toEqual([]);
  });
});

describe("findEntry", () => {
  it("finds the run plugin's src/index.tsx", () => {
    expect(findEntry(join("plugins", "run"))).toBe(
      join("plugins", "run", "src", "index.tsx"),
    );
  });

  it("throws when neither src/index.ts nor src/index.tsx exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "kd-plugin-noentry-"));
    try {
      mkdirSync(join(dir, "src"));
      expect(() => findEntry(dir)).toThrow(/no src\/index\.ts or src\/index\.tsx/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("validateManifest", () => {
  it("validates the real run manifest", () => {
    const manifest = validateManifest(join("plugins", "run"));
    expect(manifest.id).toBe("keepdeck.run");
    expect(manifest.contributes.dockTabs).toEqual([{ id: "run", label: "Run" }]);
  });

  it("fails loudly, listing every problem, for a malformed manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "kd-plugin-badmanifest-"));
    try {
      writeFileSync(
        join(dir, "manifest.json"),
        JSON.stringify({ id: "Not Lowercase", capabilities: "nope" }),
      );
      expect(() => validateManifest(dir)).toThrow(/invalid manifest/);
      try {
        validateManifest(dir);
        throw new Error("expected validateManifest to throw");
      } catch (err) {
        // Every problem is listed in one shot — not just the first.
        expect(err.message).toMatch(/name: required/);
        expect(err.message).toMatch(/id: .* must be lowercase/);
        expect(err.message).toMatch(/capabilities: must be an array/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// What the real build of the host and every plugin produced is checked where
// that build happens: the last step of `pnpm build` runs
// scripts/check-plugin-bundles.mjs over dist/. Nothing here builds it again.
describe("the script, with no plugins to build", () => {
  let distRoot;

  beforeEach(() => {
    distRoot = mkdtempSync(join(tmpdir(), "kd-plugins-dist-"));
  });

  afterEach(() => {
    rmSync(distRoot, { recursive: true, force: true });
  });

  it("is a no-op that still writes an empty index.json when plugins/ has none", () => {
    const emptyRepoPluginsRoot = mkdtempSync(join(tmpdir(), "kd-no-plugins-"));
    try {
      const out = execFileSync(
        process.execPath,
        [SCRIPT, "--out-dir", distRoot],
        {
          cwd: emptyRepoPluginsRoot,
          encoding: "utf8",
        },
      );
      expect(out).toContain("nothing to build");
      const index = JSON.parse(
        readFileSync(join(distRoot, "plugins", "index.json"), "utf8"),
      );
      expect(index).toEqual({ plugins: [] });
    } finally {
      rmSync(emptyRepoPluginsRoot, { recursive: true, force: true });
    }
  });
});

describe("bridge exports for plugin bundles", () => {
  const bridgePath = (name) =>
    join(REPO_ROOT, "src", "plugins", "bridges", name);

  it("react.js exports the hook a plugin's component actually uses", () => {
    const src = readFileSync(bridgePath("react.js"), "utf8");
    expect(src).toMatch(/\buseState\b/);
    expect(src).toMatch(/export default React/);
  });

  it("react-jsx-runtime.js exports jsx (the automatic-runtime call site)", () => {
    const src = readFileSync(bridgePath("react-jsx-runtime.js"), "utf8");
    expect(src).toMatch(/\bjsx\b/);
    expect(src).toMatch(/\bjsxs\b/);
  });

  it("react-dom-client.js exports createRoot", () => {
    const src = readFileSync(bridgePath("react-dom-client.js"), "utf8");
    expect(src).toMatch(/\bcreateRoot\b/);
  });

  it("react-dom.js shares the host's portal and synchronous render functions", async () => {
    const { default: host } = await import("react-dom");
    const bridge = await import("../src/plugins/bridges/react-dom.js");
    expect(bridge.createPortal).toBe(host.createPortal);
    expect(bridge.flushSync).toBeTypeOf("function");
    expect(bridge.flushSync).toBe(host.flushSync);
  });

  it("plugin-api.js is a plain passthrough (genuine ESM, no hand-listed names needed)", () => {
    const src = readFileSync(bridgePath("plugin-api.js"), "utf8");
    expect(src).toMatch(/export \* from ["']@keepdeck\/plugin-api["']/);
  });
});
