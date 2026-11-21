// @vitest-environment happy-dom
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginSessions } from "@keepdeck/plugin-api";
import { callsOf, useHost } from "../../testing/host/host";
import { startDeck, type Deck } from "../../testing/host/deck";

/**
 * A plugin's own processes, end to end on the app itself: started through
 * the door a plugin is handed — no pane's, leased by the machine in the
 * workspace on screen — in a folder of the plugin's choosing, as a fork's
 * export runs from the folder it forks into, or in none.
 */
describe("a plugin's own processes, on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;

  afterEach(() => {
    deck?.dispose();
    deck = null;
  });

  async function opened() {
    const d = (deck = await startDeck(host()));
    await d.workspaceUp();
    const sessions: PluginSessions | null = d.stub.sessions;
    if (!sessions) throw new Error("the stub plugin was handed no process door");
    return { d, sessions };
  }

  /** Start the stub program through the plugin's door, in `cwd`; what it
   * prints, as text, and whether it has ended. */
  async function run(d: Deck, sessions: PluginSessions, cwd: string | undefined) {
    const { command, args } = d.stubProcess(true);
    let said = "";
    let ended = false;
    const decoder = new TextDecoder();
    const handle = await sessions.spawn({ command: command ?? undefined, args, cwd, cols: 80, rows: 24 }, (event) => {
      if (event.type === "output") said += decoder.decode(event.bytes, { stream: true });
      else ended = true;
    });
    return { handle, said: () => said, ended: () => ended };
  }

  it("starts one in a folder of its choosing, leased in that folder", async () => {
    const { d, sessions } = await opened();
    const folder = join(host().work, "export");
    mkdirSync(folder);
    const { handle, said } = await run(d, sessions, folder);
    handle.write("say from its folder\r");
    await host().until("it answers", () => said().includes("\nfrom its folder\r"), 15_000);
    // The machine holds the folder it runs in, as it holds a pane's.
    expect(callsOf(host(), "lifecycle_lease")).toEqual([{ lease: expect.objectContaining({ owner: expect.objectContaining({ kind: "plugin" }), dir: folder }) }]);
    await handle.close();
  });

  it("starts one in no folder of ours when it names none", async () => {
    const { d, sessions } = await opened();
    const { handle, said } = await run(d, sessions, undefined);
    handle.write("say from nowhere\r");
    await host().until("it answers", () => said().includes("\nfrom nowhere\r"), 15_000);
    expect(callsOf(host(), "lifecycle_lease")).toEqual([{ lease: expect.objectContaining({ dir: null }) }]);
    await handle.close();
  });

  it("runs one in a fork's own checkout while the fork is forking, and stops it before the checkout goes when the fork is taken back", async () => {
    const d = (deck = await startDeck(host()));
    d.gitRepo();
    const { ws, session } = await d.agentUp();
    const sessions = d.stub.sessions;
    if (!sessions) throw new Error("the stub plugin was handed no process door");
    d.stub.rejectForks = true;
    // The fork's checkout is made; its hook is asked of the page.
    const forking = host().hold({ heard: '"kind":"fork"' });
    const path = join(host().trees, "fork-1");
    const asked = d.runtime.orchestrator.forkSession(ws.id, { agent: "stub", sessionId: session, cwd: host().work }, { kind: "worktree", path, branch: "kd/ws/fork-1" }, { role: "lead" });
    await forking.caught;
    // What the hook runs in the checkout, as opencode's export runs there.
    const { handle, said, ended } = await run(d, sessions, path);
    handle.write("say in the checkout\r");
    await host().until("it answers", () => said().includes("\nin the checkout\r"), 15_000);
    forking.release();
    expect(await asked).toMatchObject({ kind: "accepted" });
    // The fork's agent never takes the conversation up: the rollback stops
    // what runs in the checkout, then the checkout goes.
    await host().until("the fork is taken back whole", () => d.workspace().panes.length === 1 && !existsSync(path) && host().journalEmpty(), 15_000);
    expect(ended()).toBe(true);
  });
});
