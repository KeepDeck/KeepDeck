import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildManifest, parseArgs } from "./release-manifest.mjs";

const SCRIPT = fileURLToPath(new URL("./release-manifest.mjs", import.meta.url));

describe("parseArgs", () => {
  it("parses version, repo, out and repeated payloads", () => {
    expect(
      parseArgs([
        "--version", "1.2.3",
        "--repo", "KeepDeck/KeepDeck",
        "--out", "latest.json",
        "--payload", "darwin-aarch64=a.app.tar.gz",
        "--payload", "darwin-x86_64=x.app.tar.gz",
      ]),
    ).toEqual({
      version: "1.2.3",
      repo: "KeepDeck/KeepDeck",
      out: "latest.json",
      payloads: {
        "darwin-aarch64": "a.app.tar.gz",
        "darwin-x86_64": "x.app.tar.gz",
      },
    });
  });

  it.each([
    [["--repo", "r", "--out", "o", "--payload", "p=f"], /--version is required/],
    [["--version", "1.0.0", "--out", "o", "--payload", "p=f"], /--repo is required/],
    [["--version", "1.0.0", "--repo", "r", "--payload", "p=f"], /--out is required/],
    [["--version", "1.0.0", "--repo", "r", "--out", "o"], /at least one --payload/],
    [["--version", "1.0.0", "--repo", "r", "--out", "o", "--payload", "nofile"], /expects <platform>=<file>/],
    [["--oops"], /unknown argument: --oops/],
  ])("rejects bad arguments %j", (argv, error) => {
    expect(() => parseArgs(argv)).toThrow(error);
  });
});

describe("buildManifest", () => {
  const args = {
    version: "1.2.3",
    repo: "KeepDeck/KeepDeck",
    payloads: { "darwin-aarch64": "dist/KeepDeck-macos-arm64.app.tar.gz" },
  };
  const now = () => new Date("2026-07-12T10:00:00Z");

  it("maps each platform to a tag-addressed URL and its trimmed signature", () => {
    const read = (path) => {
      expect(path).toBe("dist/KeepDeck-macos-arm64.app.tar.gz.sig");
      return "SIGNATURE\n";
    };
    expect(buildManifest(args, read, now)).toEqual({
      version: "1.2.3",
      pub_date: "2026-07-12T10:00:00.000Z",
      platforms: {
        "darwin-aarch64": {
          signature: "SIGNATURE",
          url: "https://github.com/KeepDeck/KeepDeck/releases/download/latest/KeepDeck-macos-arm64.app.tar.gz",
        },
      },
    });
  });

  it("rejects a malformed version", () => {
    expect(() => buildManifest({ ...args, version: "v1.2.3" }, () => "s", now)).toThrow(
      /unsupported version format/,
    );
  });

  it("rejects an empty signature file", () => {
    expect(() => buildManifest(args, () => "  \n", now)).toThrow(/empty signature/);
  });

  it("propagates a missing signature file", () => {
    const read = () => {
      throw new Error("ENOENT");
    };
    expect(() => buildManifest(args, read, now)).toThrow(/ENOENT/);
  });
});

describe("end to end", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes latest.json for real payload files", () => {
    dir = mkdtempSync(join(tmpdir(), "kd-manifest-"));
    for (const arch of ["arm64", "x64"]) {
      writeFileSync(join(dir, `KeepDeck-macos-${arch}.app.tar.gz`), "payload");
      writeFileSync(join(dir, `KeepDeck-macos-${arch}.app.tar.gz.sig`), `sig-${arch}\n`);
    }
    const out = join(dir, "latest.json");
    execFileSync(process.execPath, [
      SCRIPT,
      "--version", "9.9.9",
      "--repo", "KeepDeck/KeepDeck",
      "--out", out,
      "--payload", `darwin-aarch64=${join(dir, "KeepDeck-macos-arm64.app.tar.gz")}`,
      "--payload", `darwin-x86_64=${join(dir, "KeepDeck-macos-x64.app.tar.gz")}`,
    ]);
    const manifest = JSON.parse(readFileSync(out, "utf8"));
    expect(manifest.version).toBe("9.9.9");
    expect(Date.parse(manifest.pub_date)).not.toBeNaN();
    expect(manifest.platforms["darwin-aarch64"]).toEqual({
      signature: "sig-arm64",
      url: "https://github.com/KeepDeck/KeepDeck/releases/download/latest/KeepDeck-macos-arm64.app.tar.gz",
    });
    expect(manifest.platforms["darwin-x86_64"].signature).toBe("sig-x64");
  });
});
