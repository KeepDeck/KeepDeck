import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildContainer,
  CONTAINER_FORMAT,
  MAX_ENTRIES,
  validatePluginDir,
} from "./pack-plugin.mjs";

const MANIFEST = {
  id: "dev.example.demo",
  name: "Demo",
  version: "1.0.0",
  minApiVersion: 3,
  capabilities: [],
  contributes: { dockTabs: [{ id: "demo", label: "Demo" }] },
};

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kdplugin-src-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(MANIFEST));
  writeFileSync(join(dir, "main.js"), "export default 1;");
  writeFileSync(join(dir, "demo.html"), "<!doctype html><p>demo</p>");
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "a.css"), "p{}");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Unzip (the real tool — an independent reader) into a temp dir. */
function unpack(bytes) {
  const zipPath = join(dir, "..", `kdplugin-${Date.now()}.kdplugin`);
  writeFileSync(zipPath, bytes);
  const out = mkdtempSync(join(tmpdir(), "kdplugin-out-"));
  try {
    execFileSync("unzip", ["-o", zipPath, "-d", out], { stdio: "pipe" });
    return out;
  } finally {
    rmSync(zipPath, { force: true });
  }
}

describe("validatePluginDir", () => {
  it("accepts the demo tree and lists files sorted", () => {
    const { manifest, files } = validatePluginDir(dir);
    expect(manifest.id).toBe("dev.example.demo");
    expect(files.map((f) => f.rel)).toEqual([
      "assets/a.css",
      "demo.html",
      "main.js",
      "manifest.json",
    ]);
  });

  it("collects EVERY problem instead of stopping at the first", () => {
    rmSync(join(dir, "demo.html"));
    writeFileSync(join(dir, "container.json"), "{}");
    let message = "";
    try {
      validatePluginDir(dir);
    } catch (e) {
      message = e.message;
    }
    expect(message).toContain("missing demo.html");
    expect(message).toContain("container.json: reserved");
  });

  it("requires main.js — a plugin is code", () => {
    rmSync(join(dir, "main.js"));
    expect(() => validatePluginDir(dir)).toThrow(/main.js: required/);
  });

  it("rejects a manifest the strict validator refuses", () => {
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ ...MANIFEST, id: "Bad Id" }),
    );
    expect(() => validatePluginDir(dir)).toThrow(/manifest.json: id/);
  });

  it("rejects a drive-letter name the reader would refuse", () => {
    writeFileSync(join(dir, "c:evil.txt"), "x");
    expect(() => validatePluginDir(dir)).toThrow(/drive-letter/);
  });

  it("rejects symlinks — the reader bans them, packing would defer the failure", () => {
    symlinkSync("/etc/hosts", join(dir, "assets", "hosts"));
    expect(() => validatePluginDir(dir)).toThrow(/symlink/);
  });

  it("enforces the entry cap", () => {
    for (let i = 0; i < MAX_ENTRIES; i++) {
      writeFileSync(join(dir, "assets", `f${i}.txt`), "x");
    }
    expect(() => validatePluginDir(dir)).toThrow(/entry cap/);
  });

  it("ignores dotfiles instead of packing tooling residue", () => {
    writeFileSync(join(dir, ".DS_Store"), "junk");
    const { files } = validatePluginDir(dir);
    expect(files.some((f) => f.rel === ".DS_Store")).toBe(false);
  });
});

describe("buildContainer", () => {
  it("round-trips through a real unzip: container.json first, content verbatim", () => {
    const { files } = validatePluginDir(dir);
    const out = unpack(buildContainer(dir, files));
    expect(JSON.parse(readFileSync(join(out, "container.json"), "utf8"))).toEqual({
      format: CONTAINER_FORMAT,
    });
    expect(readFileSync(join(out, "manifest.json"), "utf8")).toBe(
      readFileSync(join(dir, "manifest.json"), "utf8"),
    );
    expect(readFileSync(join(out, "demo.html"), "utf8")).toContain("demo");
    expect(readFileSync(join(out, "assets", "a.css"), "utf8")).toBe("p{}");
    rmSync(out, { recursive: true, force: true });
  });

  it("is byte-deterministic — same tree, identical container", () => {
    const { files } = validatePluginDir(dir);
    const a = buildContainer(dir, files);
    const b = buildContainer(dir, files);
    expect(Buffer.compare(a, b)).toBe(0);
  });
});
