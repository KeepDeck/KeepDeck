import { describe, expect, it } from "vitest";
import type { CommandRun } from "./exec";
import { v1Session, v2Session } from "./fakeOpencode.test-support";
import { recipeV1, recipeV2 } from "./forkRecipe";
import { rekeyExportV1 } from "./rekey";

/**
 * How each generation's answers are read — over the bytes opencode printed
 * in the isolated runs (/tmp/kd-task378/isolated, task-457), colour codes
 * and all: a fixture rewritten as plain text would hide a reader that only
 * matched while no colour landed inside its phrase.
 */
const run = (text: string, code: number | null): CommandRun => ({ text, code });

/** As captured: stderr then stdout, through the PTY's `\r\n`. */
const CAPTURED = {
  v1MissingExport:
    "Exporting session: ses_task457_no_such_session\r\n" +
    "\x1b[91m\x1b[1mError: \x1b[0mSession not found: ses_task457_no_such_session\r\n",
  v1Locked: "\x1b[91m\x1b[1mError: \x1b[0mUnexpected error\r\n\r\ndatabase is locked\r\n",
  v1Imported: "Imported session: ses_task457_clone_v1193\r\n",
  v1SameIdImport: "Imported session: ses_task457_source_v1193\r\n",
  v1BadShape: '\x1b[91m\x1b[1mError: \x1b[0mUnexpected error\r\n\r\nMissing key\r\n  at ["id"]\r\n',
  v2MissingExport: "Session not found: ses_task457_source_cross_v1to2\r\n",
  v2Imported: "Imported session: ses_task457_clone_v214\r\n",
  v2Collision: "Session already exists\r\n",
  v2InternalError:
    "Error: Failed to import session: Internal Server Error\r\n" +
    "    at <anonymous> (/$bunfs/root/chunk-sqgtt6qg.js:2:2432)\r\n",
};

describe("1.x answers", () => {
  it("reads an export from under the line that rides ahead of it", () => {
    const source = v1Session("ses_task457_source_v1193", "/a");
    const reading = recipeV1.readExport(
      run(`Exporting session: ses_task457_source_v1193\r\n${JSON.stringify(source, null, 2)}\r\n`, 0),
    );
    expect(reading).toEqual({ kind: "document", document: source });
  });

  it("reads a missing session through its colour codes", () => {
    expect(recipeV1.readExport(run(CAPTURED.v1MissingExport, 1))).toEqual({ kind: "missing" });
  });

  it("reads any other failure, or another generation's document, as a failure", () => {
    expect(recipeV1.readExport(run(CAPTURED.v1Locked, 1))).toMatchObject({ kind: "failed" });
    expect(recipeV1.readExport(run(JSON.stringify(v2Session("ses_x", "/a")), 0))).toEqual({
      kind: "failed",
      detail: "opencode export did not print a 1.x session",
    });
  });

  it("takes `Imported session: <the clone>` as a CLAIM only — to be read back", () => {
    expect(recipeV1.readImport(run(CAPTURED.v1Imported, 0), "ses_task457_clone_v1193")).toEqual({
      kind: "claimed",
    });
  });

  it("refuses an import that named another session — the source's own, in the measured case", () => {
    expect(recipeV1.readImport(run(CAPTURED.v1SameIdImport, 0), "ses_task457_clone_v1193")).toMatchObject({
      kind: "failed",
    });
    expect(recipeV1.readImport(run(CAPTURED.v1BadShape, 1), "ses_x")).toMatchObject({ kind: "failed" });
  });

  it("reads a clone back as the clone made, in the directory asked — `/private` being macOS's own name for `/tmp`", () => {
    const made = rekeyExportV1(v1Session("ses_f2461db4d001source0000000", "/a"), "/tmp/b");
    const landed = structuredClone(made.document);
    landed.info.directory = "/private/tmp/b";
    const verify = recipeV1.verify;
    expect(verify?.args(made.newSessionId)).toEqual(["export", made.newSessionId]);
    expect(verify?.read(run(JSON.stringify(landed), 0), made, "/tmp/b")).toEqual({ ok: true });

    landed.info.directory = "/a";
    expect(verify?.read(run(JSON.stringify(landed), 0), made, "/tmp/b")).toMatchObject({ ok: false });
  });
});

describe("2.x answers", () => {
  it("reads an export that is the payload alone", () => {
    const source = v2Session("ses_task457_source_v214", "/a");
    expect(recipeV2.readExport(run(`${JSON.stringify(source, null, 2)}\r\n`, 0))).toEqual({
      kind: "document",
      document: source,
    });
    expect(recipeV2.readExport(run(CAPTURED.v2MissingExport, 1))).toEqual({ kind: "missing" });
  });

  it("believes only its exact success line, and only with a clean exit", () => {
    expect(recipeV2.readImport(run(CAPTURED.v2Imported, 0), "ses_task457_clone_v214")).toEqual({
      kind: "imported",
    });
    expect(recipeV2.readImport(run(CAPTURED.v2Imported, 1), "ses_task457_clone_v214")).toMatchObject({
      kind: "failed",
    });
    expect(recipeV2.readImport(run(CAPTURED.v2Imported, 0), "ses_other")).toMatchObject({ kind: "failed" });
  });

  it("reads a collision — exit 0 — as a collision, and an import error as a failure", () => {
    expect(recipeV2.readImport(run(CAPTURED.v2Collision, 0), "ses_x")).toEqual({ kind: "collision" });
    expect(recipeV2.readImport(run(CAPTURED.v2InternalError, 1), "ses_x")).toMatchObject({ kind: "failed" });
    expect(recipeV2.readImport(run("", 0), "ses_x")).toMatchObject({ kind: "failed" });
  });

  it("has no read-back: its success line is final", () => {
    expect(recipeV2.verify).toBeUndefined();
  });
});

describe("the commands", () => {
  it("1.x: root export and import, the import placed by the directory it runs in", () => {
    expect(recipeV1.exportArgs("ses_s")).toEqual(["export", "ses_s"]);
    expect(recipeV1.importArgs("/tmp/f.json", "/repo")).toEqual(["import", "/tmp/f.json"]);
    expect(recipeV1.deleteArgs("ses_c")).toEqual(["session", "delete", "ses_c"]);
  });

  it("2.x: `session` commands, each with its own server, the import told its directory", () => {
    expect(recipeV2.exportArgs("ses_s")).toEqual(["session", "export", "ses_s", "--standalone"]);
    expect(recipeV2.importArgs("/tmp/f.json", "/repo")).toEqual([
      "session",
      "import",
      "/tmp/f.json",
      "--directory",
      "/repo",
      "--standalone",
    ]);
    expect(recipeV2.deleteArgs("ses_c")).toEqual(["session", "delete", "ses_c", "--standalone"]);
  });
});
