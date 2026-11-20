import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it } from "vitest";
import { fetchAppInfo } from "../../ipc/app";
import type { Heard } from "../../ipc/generated/lifecycle/Heard";
import type { Versioned } from "../../ipc/generated/lifecycle/Versioned";
import type { WorkspaceFacts } from "../../ipc/generated/lifecycle/WorkspaceFacts";
import { askLease, bootHandshake, claimsOn, subscribeLifecycle } from "../../ipc/lifecycle";
import { openSession } from "../../ipc/session";
import { createPtyManager } from "../../app/ptyManager";
import { useHost } from "./host";

/**
 * The host harness itself: the page's own IPC modules against the app
 * itself, on Tauri's test runtime in a process of its own. What these hold —
 * names, arguments, state, errors, channels, the real machines and a real
 * process — is what every test on the host stands on.
 */
describe("the host harness — the page's IPC against the app itself", () => {
  const host = useHost();

  const snapshots = (heard: Heard[]): Versioned[] => heard.flatMap((message) => (message.kind === "snapshot" ? [message.versioned] : []));

  const workspace = (cwd: string): WorkspaceFacts => ({
    id: "ws-1",
    name: "ws",
    cwd,
    worktreeBase: null,
    archived: false,
    archiving: false,
    teams: [],
    panes: [{ id: "pane-1", team: null, remote: false, suspended: false }],
  });

  it("answers a command the page calls by its name", async () => {
    expect(await fetchAppInfo()).toMatchObject({ name: "KeepDeck" });
  });

  it("hands a command the state the app manages", async () => {
    expect(await claimsOn(host().work)).toEqual([]);
  });

  it("gives the page a command's own failure as its rejection", async () => {
    await expect(invoke("pty_write", { id: 424242, data: [] })).rejects.toEqual(expect.any(String));
  });

  it("refuses a name the app does not register, as Tauri itself does", async () => {
    await expect(invoke("no_such_command")).rejects.toMatch(/no_such_command not found/);
  });

  it("refuses a wrong argument in the command's own generated wrapper", async () => {
    await expect(invoke("pty_stop", { session: 1 })).rejects.toMatch(/missing required key id/);
  });

  it("carries a channel's messages to the page in their order, those after the command returned too", async () => {
    const heard: Heard[] = [];
    await subscribeLifecycle((message) => heard.push(message));
    await host().until("the first snapshot", () => snapshots(heard).length > 0);
    expect(snapshots(heard)[0]?.snapshot.open).toBe(false);
    await bootHandshake({ workspaces: [workspace(host().work)] }, "loaded");
    await host().until("the barrier down", () => snapshots(heard).some(({ snapshot }) => snapshot.open));
    const versions = snapshots(heard).map(({ version }) => version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("holds a request, and the host's reply, until each is let go", async () => {
    const request = host().hold({ request: "app_info" });
    let answered = false;
    const asked = fetchAppInfo().then((info) => {
      answered = true;
      return info;
    });
    await request.caught;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered).toBe(false);
    const reply = host().hold({ reply: "app_info" });
    request.release();
    await reply.caught;
    expect(answered).toBe(false);
    reply.release();
    expect(await asked).toMatchObject({ name: "KeepDeck" });
  });

  it("starts a real process on the machine's lease, and the page's registry hears it speak and end", async () => {
    await subscribeLifecycle(() => {});
    await bootHandshake({ workspaces: [workspace(host().work)] }, "loaded");
    const owner = { kind: "pane", pane: "pane-1" } as const;
    const lease = await askLease({ kind: "launch", workspace: "ws-1", owner, dir: host().work });
    if (lease.kind !== "answered" || lease.answer.kind !== "leased") throw new Error(`no lease: ${JSON.stringify(lease)}`);
    const registry = createPtyManager(openSession);
    let output = "";
    registry.attach("pane-1", {
      onOutput: (bytes) => (output += new TextDecoder().decode(bytes)),
      onExit: () => {},
      onSpawnError: () => {},
      onReady: () => {},
      onLaunched: () => {},
    });
    registry.acquire(
      "pane-1",
      { command: "/bin/sh", args: ["-c", "echo READY from a real process; exec sleep 30"], cwd: host().work, cols: 80, rows: 24 },
      { permit: lease.answer.permit, owner },
    );
    await host().until("the process is live and has spoken", () => registry.state("pane-1").kind === "live" && output.includes("READY"));
    await registry.close("pane-1");
    expect(registry.state("pane-1").kind).toBe("none");
  });
});
