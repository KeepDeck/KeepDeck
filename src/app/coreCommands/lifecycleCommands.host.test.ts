// @vitest-environment happy-dom
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandResult } from "../../domain/commands";
import { createFailed, type Workspace } from "../../domain/deck";
import type { useCloseFlow as UseCloseFlow } from "../useCloseFlow";
import { useHost } from "../../testing/host/host";
import { startDeck, type Deck } from "../../testing/host/deck";
import { mountInPage } from "../../testing/host/page";
import { STUB_AGENT, type StubAgentControl } from "../../testing/host/stubPlugin";

/** What the close flow hook holds, as the app's controller hands it. */
type CloseFlow = ReturnType<typeof UseCloseFlow>;

/**
 * The commands an agent drives the deck's lifecycle with, end to end on the
 * app itself: each call goes through the page's own command registry, as an
 * MCP call arrives, to the machine — and what it starts, stops, makes or
 * removes is checked where it happens: on the deck, in the machine's word,
 * in a process, on disk.
 */
describe("the agents' lifecycle commands, on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;
  let unmount: (() => void) | null = null;

  afterEach(() => {
    unmount?.();
    unmount = null;
    deck?.dispose();
    deck = null;
  });

  const open = async (told: Partial<StubAgentControl> = {}) => (deck = await startDeck(host(), told));
  const until = (label: string, ok: () => boolean, ms = 15_000) => host().until(label, ok, ms);

  /** What a command answered, when it was carried out. */
  function answered(result: CommandResult): object {
    if (!result.ok) throw new Error(`refused: ${result.error.message}`);
    if (typeof result.value !== "object" || result.value === null) throw new Error(`answered no fields: ${JSON.stringify(result.value)}`);
    return result.value;
  }
  /** A text field of an answer. */
  function text(value: object, field: string): string {
    const found: unknown = Reflect.get(value, field);
    if (typeof found !== "string") throw new Error(`no ${field} in ${JSON.stringify(value)}`);
    return found;
  }
  /** The worktree an answer names. */
  function worktreeIn(value: object): { path: string; branch: string } {
    const worktree: unknown = Reflect.get(value, "worktree");
    if (typeof worktree !== "object" || worktree === null) throw new Error(`no worktree in ${JSON.stringify(value)}`);
    return { path: text(worktree, "path"), branch: text(worktree, "branch") };
  }
  /** Why a command was refused. */
  function refused(result: CommandResult): string {
    if (result.ok) throw new Error(`carried out: ${JSON.stringify(result.value)}`);
    return result.error.message;
  }

  const teamNamed = (ws: Workspace, name: string) => (ws.teams ?? []).find((team) => team.name === name);
  const panesOf = (ws: Workspace, teamId: string) => ws.panes.filter((pane) => pane.team?.teamId === teamId);
  const attachedAt = (d: Deck, teamId: string) => {
    const location = (d.workspace().teams ?? []).find((team) => team.id === teamId)?.location;
    return location?.kind === "attached" ? location.cwd : null;
  };
  const branches = () => execFileSync("git", ["branch", "--list", "--format=%(refname:short)"], { cwd: host().work, encoding: "utf8" });

  /** Mount the app's UI in the deck's page and bind it, as
   * `useAppController` does: the agents the plugins declare, which a
   * command names an agent type against, and the close flow — a close an
   * agent asks for opens the person's dialog, and the row answers it as the
   * person. */
  async function uiOn(d: Deck) {
    const { useCloseFlow } = await import("../useCloseFlow");
    const { useDeck } = await import("../useDeck");
    const { useAgentsFrom } = await import("../useAgents");
    const { useAgentRunView } = await import("../useAgentRunView");
    const { previewIntent } = await import("../../ipc/lifecycle");
    const { askBackgroundCarriers } = await import("../liveSessions");
    const alerts: string[] = [];
    const mounted = await mountInPage(d, () => {
      const shown = useDeck(d.runtime.deckStore);
      const { agents } = useAgentsFrom(d.runtime.plugins);
      const view = useAgentRunView(d.runtime.orchestrator);
      const flow: CloseFlow = useCloseFlow(shown, {
        onError: (message) => alerts.push(`close: ${message}`),
        onSuspendRefused: (message) => alerts.push(`suspend: ${message}`),
        preview: previewIntent,
        blockedPanes: view.blocked,
        suspendAgent: d.runtime.orchestrator.suspend,
        closeAgents: d.runtime.orchestrator.close,
        backgroundCarriers: (entries) => askBackgroundCarriers(d.runtime.spawnPlugins, entries),
      });
      return { flow, agents };
    });
    const unbind = d.runtime.application.bindUi({
      agents: () => mounted.current().agents,
      requestCloseAgent: (wsId, paneId, label) => mounted.current().flow.requestCloseAgent(wsId, paneId, label),
      requestDisbandTeam: (wsId, teamId) => mounted.current().flow.requestDisbandTeam(wsId, teamId),
      openSettings: () => false,
      openUsage: () => false,
      openTasks: () => false,
      setCreating: () => {},
      pushAlert: (title, message) => alerts.push(`${title}: ${message}`),
    });
    unmount = () => {
      unbind();
      mounted.unmount();
    };
    return { flow: () => mounted.current().flow, alerts };
  }

  it("agent.spawn gives the agent a team of its own in a new worktree, and starts it there", async () => {
    const d = await open();
    d.gitRepo();
    const ws = await d.workspaceUp();
    await uiOn(d);
    const made = answered(await d.execute("agent.spawn", { workspace: ws.id, agentType: STUB_AGENT, role: "lead" }));
    const paneId = text(made, "paneId");
    const teamId = text(made, "teamId");
    const worktree = worktreeIn(made);
    expect(worktree.path.startsWith(host().trees)).toBe(true);

    await d.upAndBound(paneId);
    expect(attachedAt(d, teamId)).toBe(worktree.path);
    expect(existsSync(worktree.path)).toBe(true);
    expect(branches()).toContain(worktree.branch);
    expect(d.launches(paneId).map(({ cwd }) => cwd)).toEqual([worktree.path]);
    expect(d.intents().map(({ kind }) => kind)).toContain("createTeam");
  });

  it("team.create makes an empty team at the root, and refuses a second there unless it is meant to share", async () => {
    const d = await open();
    const ws = await d.workspaceUp();
    const one = answered(await d.execute("team.create", { workspace: ws.id, directory: "root", name: "one" }));
    await until("one is made at the root", () => attachedAt(d, text(one, "teamId")) === host().work);
    expect(panesOf(d.workspace(), text(one, "teamId"))).toEqual([]);

    expect(refused(await d.execute("team.create", { workspace: ws.id, directory: "root", name: "two" }))).toContain("one");
    expect(teamNamed(d.workspace(), "two")).toBeUndefined();

    const two = answered(await d.execute("team.create", { workspace: ws.id, directory: "root", name: "two", shared: true }));
    await until("two shares the root", () => attachedAt(d, text(two, "teamId")) === host().work);
  });

  it("team.add puts an agent on a team where the team runs, and refuses a role the team already has", async () => {
    const d = await open();
    const { ws, paneId: lead } = await d.agentUp();
    const teamId = d.pane(lead).team?.teamId ?? "";
    await uiOn(d);
    const added = answered(await d.execute("team.add", { workspace: ws.id, team: teamId, agentType: STUB_AGENT, role: "impl-1" }));
    const member = text(added, "paneId");
    await d.upAndBound(member);
    expect(d.pane(member).team?.teamId).toBe(teamId);
    expect(d.launches(member).map(({ cwd }) => cwd)).toEqual(d.launches(lead).map(({ cwd }) => cwd));

    const panes = d.workspace().panes.length;
    expect(refused(await d.execute("team.add", { workspace: ws.id, team: teamId, agentType: STUB_AGENT, role: "lead" }))).toContain('role "lead" is taken');
    expect(d.workspace().panes).toHaveLength(panes);
  });

  it("agent.suspend stops the agent and keeps its pane; agent.resume brings the same conversation back", async () => {
    const d = await open();
    const { ws, paneId, session } = await d.agentUp();
    answered(await d.execute("agent.suspend", { workspace: ws.id, agent: paneId }));
    await until(`${paneId} suspended`, () => d.phase(paneId) === "suspended" && d.settled() && d.slot(paneId) === "none");
    expect(d.pane(paneId).session?.id).toBe(session);

    answered(await d.execute("agent.resume", { workspace: ws.id, agent: paneId }));
    await until(`${paneId} back`, () => d.slot(paneId) === "live" && d.launches(paneId).length === 2);
    expect(await d.upAndBound(paneId)).toBe(session);

    expect(refused(await d.execute("agent.resume", { workspace: ws.id, agent: paneId }))).toMatch(/is already running\.$/);
    expect(d.launches(paneId)).toHaveLength(2);
  });

  it("workspace.update changes the workspace on the deck, and the next team's worktree goes under the new base", async () => {
    const d = await open();
    d.gitRepo();
    const ws = await d.workspaceUp();
    const base = join(host().work, "..", "elsewhere");
    mkdirSync(base, { recursive: true });
    const updated = answered(await d.execute("workspace.update", { workspace: ws.id, name: "renamed", mark: "R", worktreeBaseDir: base }));
    expect(updated).toMatchObject({ workspaceId: ws.id, name: "renamed", mark: "R", worktreeBaseDir: base });
    expect(d.workspace()).toMatchObject({ name: "renamed", mark: "R", worktreeBaseDir: base });

    const team = answered(await d.execute("team.create", { workspace: ws.id, name: "next" }));
    const worktree = worktreeIn(team);
    expect(worktree.path.startsWith(base)).toBe(true);
    await until("next is made under the new base", () => attachedAt(d, text(team, "teamId")) === worktree.path);
    expect(existsSync(worktree.path)).toBe(true);

    expect(refused(await d.execute("workspace.update", { workspace: ws.id }))).toContain("nothing to change");
    expect(refused(await d.execute("workspace.update", { workspace: "", name: "x" }))).not.toBe("");
    expect(d.workspace().name).toBe("renamed");
  });

  it("team.retry retries a failed worktree create through the machine, and refuses a team with nothing to retry", async () => {
    const d = await open();
    d.gitRepo();
    const ws = await d.workspaceUp();
    mkdirSync(host().trees, { recursive: true });
    // git cannot make the worktree: its base folder takes no new entry.
    chmodSync(host().trees, 0o555);
    let teamId = "";
    try {
      const team = answered(await d.execute("team.create", { workspace: ws.id, name: "blocked" }));
      teamId = text(team, "teamId");
      await until("the create failed and the machine let it go", () => createFailed(teamNamed(d.workspace(), "blocked")?.location) && d.settled());
    } finally {
      chmodSync(host().trees, 0o755);
    }
    const retried = answered(await d.execute("team.retry", { workspace: ws.id, team: teamId }));
    const worktree = worktreeIn(retried);
    await until("the retry made it", () => attachedAt(d, teamId) === worktree.path);
    expect(existsSync(worktree.path)).toBe(true);
    expect(d.intents().map(({ kind }) => kind)).toContain("retry");

    expect(refused(await d.execute("team.retry", { workspace: ws.id, team: teamId }))).toContain("not waiting on a worktree create");
  });

  it("agent.close opens the person's confirm, and the agent goes only once they confirm", async () => {
    const d = await open();
    const { ws, paneId: lead } = await d.agentUp();
    const member = await d.memberUp(d.pane(lead).team?.teamId ?? "", "impl-1");
    const { flow } = await uiOn(d);

    expect(answered(await d.execute("agent.close", { workspace: ws.id, agent: member }))).toMatchObject({ paneId: member, confirm: "dialog" });
    await until("the confirm is open", () => flow().closing !== null);
    await act(async () => flow().cancelClose());
    expect(d.intents().some((intent) => intent.kind === "closeAgent")).toBe(false);
    expect(d.slot(member)).toBe("live");

    answered(await d.execute("agent.close", { workspace: ws.id, agent: member }));
    await until("the confirm is open again", () => flow().closing !== null);
    await act(async () => flow().confirmClose());
    await until(`${member} has left the deck, its process ended`, () => !d.workspace().panes.some((pane) => pane.id === member) && d.slot(member) === "none");
    expect(d.slot(lead)).toBe("live");
  });

  it("team.disband takes the team, and its worktree and branch only when the person ticks the box", async () => {
    const d = await open();
    d.gitRepo();
    const ws = await d.workspaceUp();
    const { flow } = await uiOn(d);
    const teamUp = async (name: string) => {
      const made = answered(await d.execute("team.create", { workspace: ws.id, name }));
      const teamId = text(made, "teamId");
      const worktree = worktreeIn(made);
      await until(`${name} is made`, () => attachedAt(d, teamId) === worktree.path);
      await d.memberUp(teamId, "lead");
      return { teamId, worktree };
    };
    const disband = async (teamId: string, deleting: boolean) => {
      answered(await d.execute("team.disband", { workspace: ws.id, team: teamId }));
      await until("the confirm is open", () => flow().closing !== null);
      await act(async () => flow().setDeleteWorktree(deleting));
      await act(async () => flow().confirmClose());
      await until(`${teamId} is gone`, () => !(d.workspace().teams ?? []).some((team) => team.id === teamId) && d.settled());
    };

    const kept = await teamUp("kept");
    await disband(kept.teamId, false);
    expect(existsSync(kept.worktree.path)).toBe(true);
    expect(branches()).toContain(kept.worktree.branch);

    const gone = await teamUp("gone");
    await disband(gone.teamId, true);
    await until("its worktree and then its branch are removed", () => !existsSync(gone.worktree.path) && !branches().includes(gone.worktree.branch));
  });
});
