import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@keepdeck/plugin-api";
import { treeHealth, warmConfigDir } from "./warm";

const DIR = "/cfg/ws-1";

/** A provenanced entry, as a finished install records one. */
const good = { resolved: "https://registry/x.tgz", integrity: "sha512-x" };

function lock(entries: Record<string, unknown>): string {
  return JSON.stringify({ packages: { "": {}, ...entries } });
}

/** A ctx whose fs answers from `files` and whose exec records what it was
 * asked to run. Anything not in `files` rejects, the way a missing file
 * does. */
function ctxWith(files: Record<string, string>, execOk = true) {
  const runOnce = vi.fn(async () => ({ ran: true, ok: execOk, said: execOk ? "" : "boom" }));
  const warn = vi.fn();
  const ctx = {
    services: {
      fs: {
        readFile: async (path: string) => {
          const text = files[path];
          if (text === undefined) throw new Error(`ENOENT: ${path}`);
          return { text };
        },
      },
      exec: { runOnce },
    },
    log: { info() {}, warn, error() {} },
  } as unknown as PluginContext;
  return { ctx, runOnce, warn };
}

describe("treeHealth", () => {
  it("calls a dir with no manifest absent — opencode never bootstrapped it", async () => {
    const { ctx } = ctxWith({});
    expect(await treeHealth(ctx, DIR)).toEqual({ state: "absent" });
  });

  it("calls a manifest with no provenance empty — nothing installed yet", async () => {
    const { ctx } = ctxWith({ [`${DIR}/package.json`]: "{}" });
    expect(await treeHealth(ctx, DIR)).toEqual({ state: "empty" });
  });

  it("calls a fully provenanced tree healthy", async () => {
    const { ctx } = ctxWith({
      [`${DIR}/package.json`]: "{}",
      [`${DIR}/node_modules/.package-lock.json`]: lock({ a: good, b: good }),
    });
    expect(await treeHealth(ctx, DIR)).toEqual({ state: "healthy" });
  });

  it("calls the real damaged shape broken — one entry of many carries provenance", async () => {
    // The tree that prompted all this: an interrupted install left 1 entry
    // of 27 with `resolved`/`integrity`, and opencode loaded it silently.
    const entries: Record<string, unknown> = { a: good };
    for (let i = 0; i < 26; i += 1) entries[`p${i}`] = {};
    const { ctx } = ctxWith({
      [`${DIR}/package.json`]: "{}",
      [`${DIR}/node_modules/.package-lock.json`]: lock(entries),
    });
    expect(await treeHealth(ctx, DIR)).toEqual({ state: "broken" });
  });

  it("treats a written-but-empty field as unfinished, not as present", async () => {
    const { ctx } = ctxWith({
      [`${DIR}/package.json`]: "{}",
      [`${DIR}/node_modules/.package-lock.json`]: lock({
        a: { resolved: "", integrity: "" },
      }),
    });
    expect(await treeHealth(ctx, DIR)).toEqual({ state: "broken" });
  });

  it("does not count the root key, which describes the dir and not a download", async () => {
    const { ctx } = ctxWith({
      [`${DIR}/package.json`]: "{}",
      [`${DIR}/node_modules/.package-lock.json`]: lock({}),
    });
    expect(await treeHealth(ctx, DIR)).toEqual({ state: "healthy" });
  });

  it("calls an unparseable provenance file broken rather than throwing", async () => {
    const { ctx } = ctxWith({
      [`${DIR}/package.json`]: "{}",
      [`${DIR}/node_modules/.package-lock.json`]: "{ not json",
    });
    expect(await treeHealth(ctx, DIR)).toEqual({ state: "empty" });
  });
});

describe("warmConfigDir", () => {
  it("runs the bootstrap against the dir when nothing is installed", async () => {
    const { ctx, runOnce } = ctxWith({ [`${DIR}/package.json`]: "{}" });

    await warmConfigDir(ctx, DIR);

    expect(runOnce).toHaveBeenCalledWith({
      // Keyed on the dir: two panes of one workspace must collapse into one
      // run, and panes are not what they share — the dir is.
      key: DIR,
      command: "opencode",
      args: ["models"],
      env: [["OPENCODE_CONFIG_DIR", DIR]],
    });
  });

  it("asks for nothing when the tree is already healthy", async () => {
    const { ctx, runOnce } = ctxWith({
      [`${DIR}/package.json`]: "{}",
      [`${DIR}/node_modules/.package-lock.json`]: lock({ a: good }),
    });

    await warmConfigDir(ctx, DIR);

    expect(runOnce).not.toHaveBeenCalled();
  });

  it("leaves a half-installed tree alone and says so", async () => {
    // Overwriting somebody's lived-in home is not a decision a background
    // job gets to make; the honest move is to say what was found.
    const { ctx, runOnce, warn } = ctxWith({
      [`${DIR}/package.json`]: "{}",
      [`${DIR}/node_modules/.package-lock.json`]: lock({ a: good, b: {} }),
    });

    await warmConfigDir(ctx, DIR);

    expect(runOnce).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("half-installed"));
  });

  it("never throws when the run fails — a cold boot beats a failed plan", async () => {
    const { ctx, warn } = ctxWith({ [`${DIR}/package.json`]: "{}" }, false);

    await expect(warmConfigDir(ctx, DIR)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("never throws when the host refuses the call outright", async () => {
    const { ctx } = ctxWith({ [`${DIR}/package.json`]: "{}" });
    (ctx.services.exec.runOnce as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValue(new Error("no exec capability"));

    await expect(warmConfigDir(ctx, DIR)).resolves.toBeUndefined();
  });
});
