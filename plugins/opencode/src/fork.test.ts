import { describe, expect, it, vi } from "vitest";
import type { ForkPlanInput, PluginContext } from "@keepdeck/plugin-api";
import { opencodeForkPlan, relocatingForkId, targetExists } from "./fork";
import type { OpencodeExport } from "./rekey";

const SRC = "ses_0db9e24cbffej1WlbsRKynAHf3";

function exportDoc(): OpencodeExport {
  return {
    info: { id: SRC, directory: "/src/worktree", projectID: "proj-src", title: "investigation" },
    messages: [
      {
        info: { id: "msg_aaaa0001rzij8gRRPwcFG1", sessionID: SRC, role: "user" },
        parts: [
          { id: "prt_aaaa0001rzij8gRRPwcFG1", messageID: "msg_aaaa0001rzij8gRRPwcFG1", sessionID: SRC, type: "text", text: "hi" },
        ],
      },
    ],
  };
}

type SpawnEvent = { type: "output"; bytes: Uint8Array } | { type: "exit"; code: number | null };

/** Per-command overrides so a test can bend one leg (bad exit code, garbage
 * output, a hang) without replacing the whole spawn fake. */
interface Behavior {
  exportText?: (src: string) => string;
  exportCode?: number | null;
  importText?: (writtenId: string) => string;
  importCode?: number | null;
  exportHang?: boolean;
  importHang?: boolean;
}

interface Fx {
  ctx: PluginContext;
  writes: Map<string, string>;
  spawns: { args: string[]; cwd?: string }[];
  warns: string[];
}

function fixture(opts?: { targetMissing?: boolean; behavior?: Behavior }): Fx {
  const b = opts?.behavior ?? {};
  const writes = new Map<string, string>();
  const spawns: { args: string[]; cwd?: string }[] = [];
  const warns: string[] = [];
  const enc = (s: string) => new TextEncoder().encode(s);
  const ctx = {
    log: { info() {}, warn: (m: string) => warns.push(m), error() {} },
    services: {
      fs: {
        readDir: async (path: string) => {
          if (opts?.targetMissing) throw new Error(`ENOENT: ${path}`);
          return [];
        },
      },
      fsWrite: { writeFile: async (p: string, t: string) => void writes.set(p, t) },
      sessions: {
        spawn: async (o: { args: string[]; cwd?: string }, onEvent: (e: SpawnEvent) => void) => {
          spawns.push({ args: o.args, cwd: o.cwd });
          const isExport = o.args[0] === "export";
          if (!(isExport ? b.exportHang : b.importHang)) {
            queueMicrotask(() => {
              if (isExport) {
                const text = b.exportText ? b.exportText(SRC) : `Exporting session: ${SRC}\r\n${JSON.stringify(exportDoc())}`;
                onEvent({ type: "output", bytes: enc(text) });
                onEvent({ type: "exit", code: b.exportCode ?? 0 });
              } else {
                const id = JSON.parse(writes.get(o.args[1]) ?? "{}").info.id as string;
                const text = b.importText ? b.importText(id) : `Imported session: ${id}\r\n`;
                onEvent({ type: "output", bytes: enc(text) });
                onEvent({ type: "exit", code: b.importCode ?? 0 });
              }
            });
          }
          return { id: "h", write: async () => {}, resize: async () => {}, close: async () => {} };
        },
      },
    },
  } as unknown as PluginContext;
  return { ctx, writes, spawns, warns };
}

const forkInput = (cwd: string): ForkPlanInput => ({
  paneId: "pane-7",
  workspace: { id: "ws-1", instance: "wsi-1" } as ForkPlanInput["workspace"],
  cwd,
  sessionId: SRC,
  sourceCwd: "/src/worktree",
});

describe("opencodeForkPlan", () => {
  it("clones into the target and returns the new id; one pane-scoped temp file", async () => {
    const fx = fixture();
    const newId = await opencodeForkPlan(fx.ctx, forkInput("/new/target"));
    expect(newId).not.toBe(SRC);

    expect(fx.writes.size).toBe(1);
    const [path, text] = [...fx.writes.entries()][0];
    // Bounded name (per pane), not an unbounded uuid pile.
    expect(path).toBe("/tmp/keepdeck-opencode/fork-pane-7.json");
    const clone = JSON.parse(text) as OpencodeExport;
    expect(clone.info.id).toBe(newId);
    expect(clone.info.directory).toBe("/new/target");
    expect(clone.messages[0].info.sessionID).toBe(newId);
    expect(clone.messages[0].info.id).not.toBe("msg_aaaa0001rzij8gRRPwcFG1");
  });

  it("runs `import` FROM the target dir (that's what binds the directory)", async () => {
    const fx = fixture();
    await opencodeForkPlan(fx.ctx, forkInput("/new/target"));
    const importSpawn = fx.spawns.find((s) => s.args[0] === "import");
    expect(importSpawn?.cwd).toBe("/new/target");
    expect(importSpawn?.args[1]).toBe("/tmp/keepdeck-opencode/fork-pane-7.json");
  });

  it("extractJson survives a trailing brace-bearing line after the JSON", async () => {
    const fx = fixture({
      behavior: { exportText: (src) => `Exporting session: ${src}\r\n${JSON.stringify(exportDoc())}\r\nWARN: trailing note with a } brace` },
    });
    // A naive first-{ .. last-} slice would break here; the matching-brace scan holds.
    await expect(opencodeForkPlan(fx.ctx, forkInput("/t"))).resolves.toMatch(/^ses_/);
  });

  it("throws when import exits non-zero (exit code is the authoritative signal)", async () => {
    const fx = fixture({ behavior: { importCode: 1, importText: () => "error: bad file" } });
    await expect(opencodeForkPlan(fx.ctx, forkInput("/t"))).rejects.toThrow("import failed (exit 1)");
  });

  it("throws when export exits non-zero, before parsing", async () => {
    const fx = fixture({ behavior: { exportCode: 1, exportText: () => "session not found" } });
    await expect(opencodeForkPlan(fx.ctx, forkInput("/t"))).rejects.toThrow("export exited 1");
    expect(fx.writes.size).toBe(0);
  });

  it("throws on an export that exits 0 but has no JSON payload", async () => {
    const fx = fixture({ behavior: { exportCode: 0, exportText: () => "nothing here" } });
    await expect(opencodeForkPlan(fx.ctx, forkInput("/t"))).rejects.toThrow("no JSON payload");
    expect(fx.writes.size).toBe(0);
  });

  it("rejects (does not hang) when a command never exits — timeout fires", async () => {
    vi.useFakeTimers();
    try {
      const fx = fixture({ behavior: { exportHang: true } });
      const p = opencodeForkPlan(fx.ctx, forkInput("/t"));
      p.catch(() => {}); // pre-empt unhandled-rejection noise
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(p).rejects.toThrow("timed out");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("relocatingForkId", () => {
  it("returns the relocated session id when the target exists and the recipe succeeds", async () => {
    const fx = fixture();
    const id = await relocatingForkId(fx.ctx, forkInput("/new/target"));
    expect(id).toMatch(/^ses_/);
    expect(id).not.toBe(SRC);
    expect(fx.warns).toHaveLength(0);
  });

  it("returns null (native fallback) for a not-yet-provisioned target — no spawn, no warn", async () => {
    const fx = fixture({ targetMissing: true });
    expect(await relocatingForkId(fx.ctx, forkInput("/future/worktree"))).toBeNull();
    expect(fx.spawns).toHaveLength(0);
    expect(fx.warns).toHaveLength(0); // expected path, not an error
  });

  it("returns null and WARNS when the recipe throws — never propagates (no hard-fail)", async () => {
    const fx = fixture({ behavior: { importCode: 1, importText: () => "boom" } });
    expect(await relocatingForkId(fx.ctx, forkInput("/new/target"))).toBeNull();
    expect(fx.warns).toHaveLength(1);
    expect(fx.warns[0]).toContain("native --fork fallback");
  });
});

describe("targetExists", () => {
  it("is true when the directory lists, false when it doesn't", async () => {
    expect(await targetExists(fixture().ctx, "/exists")).toBe(true);
    expect(await targetExists(fixture({ targetMissing: true }).ctx, "/gone")).toBe(false);
  });
});
