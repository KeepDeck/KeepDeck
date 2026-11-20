import { describe, expect, it, vi } from "vitest";
import type { Reply } from "../../ipc/generated/lifecycle/Reply";
import type { Session } from "../../ipc/session";
import { refusalText } from "../../presentation/lifecycleWords";
import { createPluginSessions, type PluginSessionsDeps } from "./pluginSessions";

const OPTS = { command: "make", args: ["run"], cwd: "/repo", cols: 80, rows: 24 };

function rig(reply: Reply, workspace: string | null = "ws-a") {
  const session: Session = {
    id: 12,
    write: vi.fn(async () => {}),
    resize: vi.fn(async () => {}),
    stop: vi.fn(async () => "exited" as const),
  };
  const deps = {
    lease: vi.fn(async () => reply),
    workspace: () => workspace,
    open: vi.fn<PluginSessionsDeps["open"]>(async () => session),
  };
  return { deps, session, sessions: createPluginSessions(deps) };
}

describe("createPluginSessions", () => {
  it("launches a plugin's process under the plugin's lease in the workspace on screen, with no folder of ours", async () => {
    const r = rig({ kind: "answered", answer: { kind: "leased", permit: 3 } });
    const handle = await r.sessions.spawn("p.run", OPTS, () => {});
    const owner = { kind: "plugin", plugin: "p.run", workspace: "ws-a" };
    expect(r.deps.lease).toHaveBeenCalledWith({ kind: "launch", workspace: "ws-a", owner, dir: null });
    expect(r.deps.open).toHaveBeenCalledWith(expect.objectContaining({ command: "make", cwd: "/repo" }), 3, owner, expect.any(Function));
    expect(handle.id).toBe("12");
  });

  it("closes the exact session it started", async () => {
    const r = rig({ kind: "answered", answer: { kind: "leased", permit: 3 } });
    const handle = await r.sessions.spawn("p.run", OPTS, () => {});
    await handle.close();
    expect(r.session.stop).toHaveBeenCalledTimes(1);
  });

  it("starts nothing the machine will not lease, and says why in the lifecycle's words", async () => {
    const r = rig({ kind: "answered", answer: { kind: "refused", refusal: { kind: "archived" } } });
    await expect(r.sessions.spawn("p.run", OPTS, () => {})).rejects.toThrow(refusalText({ kind: "archived" }));
    expect(r.deps.open).not.toHaveBeenCalled();
  });

  it("starts nothing with no workspace open to own it", async () => {
    const r = rig({ kind: "answered", answer: { kind: "leased", permit: 3 } }, null);
    await expect(r.sessions.spawn("p.run", OPTS, () => {})).rejects.toThrow(/no workspace is open/);
    expect(r.deps.lease).not.toHaveBeenCalled();
  });

  it("hands the plugin its process's output and exit in the plugin API's shape", async () => {
    const r = rig({ kind: "answered", answer: { kind: "leased", permit: 3 } });
    const seen: unknown[] = [];
    await r.sessions.spawn("p.run", OPTS, (event) => seen.push(event));
    const deliver = r.deps.open.mock.calls[0][3];
    deliver({ type: "output", bytes: Uint8Array.from([104]) });
    deliver({ type: "exit", success: false, code: 2 });
    expect(seen).toEqual([
      { type: "output", bytes: Uint8Array.from([104]) },
      { type: "exit", code: 2 },
    ]);
  });
});
