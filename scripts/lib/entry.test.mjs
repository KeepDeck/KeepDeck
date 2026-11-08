import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isEntryPoint } from "./entry.mjs";

describe("isEntryPoint", () => {
  /** @type {string} */
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kd-entry-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A script that says whether it believes it was run. */
  const script = () => {
    const file = join(dir, "script.mjs");
    writeFileSync(
      file,
      `import { isEntryPoint } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "entry.mjs")).href)};\n` +
        `console.log(isEntryPoint(import.meta.url) ? "ran" : "skipped");\n`,
    );
    return file;
  };

  it("runs a script named by its own path", () => {
    expect(execFileSync(process.execPath, [script()], { encoding: "utf8" }).trim()).toBe("ran");
  });

  it("runs a script named through a symlink — the release scripts used to exit 0 having done nothing", () => {
    const link = join(dir, "linked.mjs");
    symlinkSync(script(), link);
    expect(execFileSync(process.execPath, [link], { encoding: "utf8" }).trim()).toBe("ran");
  });

  it("is not the entry point of a run that named another program, or none", () => {
    const file = script();
    const other = join(dir, "other.mjs");
    writeFileSync(other, "");
    const url = pathToFileURL(file).href;
    expect(isEntryPoint(url, other)).toBe(false);
    expect(isEntryPoint(url, undefined)).toBe(false);
    expect(isEntryPoint(url, join(dir, "gone.mjs"))).toBe(false);
    expect(isEntryPoint(url, file)).toBe(true);
  });
});
