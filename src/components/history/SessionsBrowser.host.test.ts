// @vitest-environment happy-dom
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installResizeObserver, pinListViewport } from "@keepdeck/ui-kit/virtualGeometry.test-support";
import { repliedTo, callsOf, useHost } from "../../testing/host/host";
import { startDeck, type Deck } from "../../testing/host/deck";
import { mountInPage, renderInPage } from "../../testing/host/page";
import type { StubAgentControl } from "../../testing/host/stubPlugin";

/**
 * A team's sessions on the app itself: an open team with nobody on it shows
 * the sessions it can continue, drawn from the deck's own journal and the
 * agent's store through the real index, each Resume held back by what the
 * app knows — the folder on disk, the pane a session is in, the directory it
 * was recorded in. How the list words and draws a fact is the component's
 * suite; that the fact is the app's is this one.
 */
describe("a team's sessions, on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;
  let unmount: (() => void) | null = null;
  let restoreViewport: () => void = () => {};

  beforeEach(() => {
    // The virtualized list needs the browser geometry the stand lacks — the
    // browser imitated, not the list's own logic.
    installResizeObserver();
    restoreViewport = pinListViewport("browser__list", 600);
  });
  afterEach(() => {
    unmount?.();
    unmount = null;
    restoreViewport();
    deck?.dispose();
    deck = null;
  });

  const open = async (told: Partial<StubAgentControl> = {}) => (deck = await startDeck(host(), told));
  const until = (label: string, ok: () => boolean, ms = 15_000) => host().until(label, ok, ms);

  /** Open `teamId` on the stage and mount what the stage shows for it, as
   * the deck's stage does for a team with nobody on it. Nothing here is
   * continued: what a click on Resume does is the dialog's suite. */
  async function sessionsOf(d: Deck, teamId: string) {
    const { useDeck } = await import("../../app/useDeck");
    const { useAgentsFrom } = await import("../../app/useAgents");
    const { useBrowserSharedSeam } = await import("../../app/useSessionsBrowser");
    const { stageContent } = await import("../../presentation/stageView");
    const { TeamSessions } = await import("../deck/TeamSessions");
    const wsId = d.workspace().id;
    // Opened as a person opens it: the deck's own action.
    const deckView = await mountInPage(d, () => useDeck(d.runtime.deckStore));
    act(() => deckView.current().openTeam(wsId, teamId));
    deckView.unmount();
    unmount = await renderInPage(d, function Stage() {
      const shown = useDeck(d.runtime.deckStore);
      const { agents, loading } = useAgentsFrom(d.runtime.plugins);
      const browserShared = useBrowserSharedSeam();
      const ws = shown.workspaces.find((candidate) => candidate.id === wsId);
      if (!ws) return null;
      const content = stageContent(ws, shown.viewOf(ws.id), 0, (team) => d.runtime.orchestrator.teamActs(ws.id, team));
      if (content.kind !== "team-sessions") return null;
      return createElement(TeamSessions, {
        ws,
        cwd: content.cwd,
        journal: shown.journal.records,
        browserShared,
        agents,
        agentsReady: !loading,
        onContinue: () => undefined,
      });
    });
  }

  /** The list's row for `sessionId`, if it draws one. */
  const rowOf = (sessionId: string) =>
    [...document.querySelectorAll(".history__row")].find((row) => row.querySelector(".browser__name")?.getAttribute("title") === sessionId);
  /** How a row's Resume reads: held back or not, and why. */
  const resumeOf = (sessionId: string) => {
    const button = rowOf(sessionId)?.querySelector<HTMLButtonElement>(".history__resume");
    return button ? { disabled: button.disabled, title: button.title } : null;
  };
  const forks = (sessionId: string) => rowOf(sessionId)?.querySelector(".history__fork") != null;

  it("draws the deck's journal: a session of the team's folder resumes, one of another forks only, one in a pane is held — each saying why", async () => {
    const d = await open();
    await d.workspaceUp();
    const elsewhere = join(host().work, "elsewhere");
    mkdirSync(elsewhere);
    const here = await d.teamUp("here", { kind: "root" });
    const there = await d.teamUp("there", { kind: "existing", cwd: elsewhere });
    const ownPane = await d.memberUp(here, "lead");
    const own = d.pane(ownPane).session?.id ?? "";
    const otherPane = await d.memberUp(there, "lead");
    const other = d.pane(otherPane).session?.id ?? "";
    await d.closeAgent(ownPane);
    await d.closeAgent(otherPane);
    const heldPane = await d.memberUp(there, "lead");
    const held = d.pane(heldPane).session?.id ?? "";

    await sessionsOf(d, here);
    await until("the list draws the three", () => [own, other, held].every((id) => rowOf(id) !== undefined));
    expect(resumeOf(own)).toEqual({ disabled: false, title: `Resume in ${host().work}` });
    expect(resumeOf(other)).toEqual({ disabled: true, title: "recorded in another directory — fork a copy into this team" });
    expect(resumeOf(held)).toEqual({ disabled: true, title: "already in a pane" });
    expect(forks(other) && forks(held)).toBe(true);
  });

  it("draws what the agent's store holds: a folder since removed is gone, a session naming none is never asked about, each saying so", async () => {
    const d = await open({ history: true });
    await d.workspaceUp();
    const removed = join(host().work, "removed");
    mkdirSync(removed);
    // The CLI's past conversations, in its store: none of them ran on
    // this deck.
    const kept = (sessionId: string, records: object[]) =>
      writeFileSync(join(d.stub.storeDir, `${sessionId}.jsonl`), records.map((record) => `${JSON.stringify(record)}\n`).join(""));
    mkdirSync(d.stub.storeDir, { recursive: true });
    kept("in-team", [{ type: "session", cwd: host().work }, { type: "turn", role: "user", text: "in the team's folder" }]);
    kept("in-removed", [{ type: "session", cwd: removed }, { type: "turn", role: "user", text: "in a folder since removed" }]);
    kept("no-folder", [{ type: "turn", role: "user", text: "naming no folder" }]);
    rmSync(removed, { recursive: true });
    const here = await d.teamUp("here", { kind: "root" });
    const mark = host().tape.length;

    await sessionsOf(d, here);
    await until("the list draws the store's three", () => ["in-team", "in-removed", "no-folder"].every((id) => rowOf(id) !== undefined));
    const answered = () => repliedTo(host(), "worktree_probe", mark).map((args) => Reflect.get(Object(args), "path"));
    await until("both folders are answered", () => answered().includes(host().work) && answered().includes(removed));
    // The answer is on the pipe before the list has drawn it.
    await until("the removed folder reads gone", () => rowOf("in-removed")?.querySelector(".history__meta-mark")?.textContent === "dir gone");
    expect(resumeOf("in-team")).toEqual({ disabled: false, title: `Resume in ${host().work}` });
    expect(resumeOf("in-removed")).toEqual({ disabled: true, title: "directory is gone — fork instead" });
    // No folder is absence, not a folder gone: no mark, and its own words.
    expect(rowOf("no-folder")?.querySelector(".history__meta-mark")).toBeNull();
    expect(resumeOf("no-folder")).toEqual({ disabled: true, title: "no recorded directory — fork instead" });
    expect(forks("in-removed") && forks("no-folder")).toBe(true);
    // A blank folder is never asked about.
    expect(callsOf(host(), "worktree_probe", mark).map((args) => Reflect.get(Object(args), "path"))).not.toContain("");
  });
});
