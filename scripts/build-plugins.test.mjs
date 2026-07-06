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
  it("finds the real sample plugin under plugins/", () => {
    expect(findPluginDirs("plugins")).toContain(join("plugins", "sample"));
  });

  it("returns an empty list when the plugins root does not exist", () => {
    expect(findPluginDirs("plugins-that-do-not-exist")).toEqual([]);
  });
});

describe("findEntry", () => {
  it("finds the sample plugin's src/index.tsx", () => {
    expect(findEntry(join("plugins", "sample"))).toBe(
      join("plugins", "sample", "src", "index.tsx"),
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
  it("validates the real sample manifest", () => {
    const manifest = validateManifest(join("plugins", "sample"));
    expect(manifest.id).toBe("keepdeck.sample");
    expect(manifest.contributes.dockTabs).toEqual([{ id: "sample", label: "Sample" }]);
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

describe("build pipeline (e2e against the real plugins/sample)", () => {
  let distRoot;

  beforeEach(() => {
    distRoot = mkdtempSync(join(tmpdir(), "kd-plugins-dist-"));
  });

  afterEach(() => {
    rmSync(distRoot, { recursive: true, force: true });
  });

  it("builds keepdeck.sample with externals kept bare, manifest copied, index.json deterministic", () => {
    const out = execFileSync(process.execPath, [SCRIPT, "--out-dir", distRoot], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    expect(out).toContain("built keepdeck.sample");
    expect(out).toContain("built keepdeck.run");

    const bundlePath = join(distRoot, "plugins", "keepdeck.sample", "index.js");
    const bundle = readFileSync(bundlePath, "utf8");

    // The externals stayed bare specifiers — react and react/jsx-runtime were
    // NOT inlined, they're still imported at runtime through the host's
    // import map.
    expect(bundle).toMatch(/from\s*["']react["']/);
    expect(bundle).toMatch(/from\s*["']react\/jsx-runtime["']/);
    // If externalization had failed, react's own hook implementation (which
    // defines useState in terms of useReducer) would be inlined here; its
    // complete absence is the signal that only a bare import landed.
    expect(bundle).not.toMatch(/useReducer/);

    // manifest.json copied byte-for-byte.
    const copiedManifest = readFileSync(
      join(distRoot, "plugins", "keepdeck.sample", "manifest.json"),
      "utf8",
    );
    const sourceManifest = readFileSync(
      join(REPO_ROOT, "plugins", "sample", "manifest.json"),
      "utf8",
    );
    expect(copiedManifest).toBe(sourceManifest);

    // index.json lists every built-in plugin, sorted by id, in the documented
    // shape (keepdeck.run sorts before keepdeck.sample).
    const index = JSON.parse(
      readFileSync(join(distRoot, "plugins", "index.json"), "utf8"),
    );
    expect(index).toEqual({
      plugins: [
        { id: "keepdeck.run", dir: "plugins/keepdeck.run" },
        { id: "keepdeck.sample", dir: "plugins/keepdeck.sample" },
      ],
    });
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

describe("bridge source files export the names plugin bundles need", () => {
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

  it("plugin-api.js is a plain passthrough (genuine ESM, no hand-listed names needed)", () => {
    const src = readFileSync(bridgePath("plugin-api.js"), "utf8");
    expect(src).toMatch(/export \* from ["']@keepdeck\/plugin-api["']/);
  });
});
