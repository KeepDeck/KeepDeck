// @vitest-environment happy-dom
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useHost } from "../testing/host/host";
import { startDeck, type Deck } from "../testing/host/deck";

/**
 * The page's runtime and the lifecycle machine, over the real channel: the
 * order they meet in at boot, how a command of the machine is carried into
 * the deck and answered, and what the page asks rather than writes.
 */
describe("the runtime and the lifecycle machine, on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;

  afterEach(() => {
    deck?.dispose();
    deck = null;
  });

  const open = async () => (deck = await startDeck(host()));
  /** The tape lines of the current launch the page sent with `cmd`. */
  const sent = (cmd: string) => host().tape.slice(host().launchedAt()).filter(({ way, line }) => way === "page →" && line.includes(`"cmd":"${cmd}"`));
  const argsOf = (line: string): unknown => Reflect.get(JSON.parse(line), "args");
  /** The page's answers to the machine's command `id`. */
  const answersTo = (id: string) =>
    sent("lifecycle_applied").filter(({ line }) => {
      const args = argsOf(line);
      return typeof args === "object" && args !== null && JSON.stringify(Reflect.get(args, "id")) === id;
    });

  it("subscribes before the handshake, and hands the machine the deck as it loaded", async () => {
    let d = await open();
    const { paneId, session } = await d.agentUp();
    await host().until("on disk", () => readFileSync(join(host().home, "deck.json"), "utf8").includes(session));
    d.dispose();
    await host().relaunch("quit");
    d = await open();
    const order = host().tape.slice(host().launchedAt()).map(({ line }) => line);
    const subscribed = order.findIndex((line) => line.includes('"cmd":"lifecycle_subscribe"'));
    const shaken = order.findIndex((line) => line.includes('"cmd":"lifecycle_boot_handshake"'));
    expect(subscribed).toBeGreaterThanOrEqual(0);
    expect(subscribed).toBeLessThan(shaken);
    const [handshake] = sent("lifecycle_boot_handshake");
    expect(argsOf(handshake.line)).toMatchObject({ load: "loaded" });
    expect(handshake.line).toContain(paneId);
    // Let the boot it set off finish before the app goes.
    await host().until("its agent is back", () => d.slot(paneId) === "live", 15_000);
  });

  it("carries a deck command into the deck once, answers it once, and says the revision it saved", async () => {
    const d = await open();
    const { ws, paneId } = await d.agentUp();
    const consent = await d.consentFor({ kind: "closeAgent", workspace: ws.id, pane: paneId, consent: { stops: [], folders: [], tickets: [] } });
    await d.runtime.orchestrator.close({ kind: "agent", workspace: ws, paneId, consent });
    await host().until("the pane is gone", () => d.workspace().panes.length === 0 && d.settled());
    // Every snapshot carries the command until it settles: it is applied
    // and answered once all the same.
    const heard = host().tape.filter(({ way, line }) => way === "← host" && line.includes('"kind":"removePane"')).length;
    expect(heard).toBeGreaterThan(1);
    expect(answersTo(commandId(host(), "removePane"))).toHaveLength(1);
    await host().until("the deck's revision is said saved", () => {
      const said = sent("lifecycle_deck_saved");
      const last = said[said.length - 1];
      return last !== undefined && JSON.stringify(argsOf(last.line)) === JSON.stringify({ revision: d.runtime.deckStore.revision() });
    });
  });

  it("ends an agent's launch plan when the machine retires it, and answers the retire", async () => {
    const d = await open();
    const { ws, paneId } = await d.agentUp();
    expect(d.runtime.orchestrator.getView().specs[paneId]).toBeDefined();
    await d.runtime.orchestrator.suspend(ws.id, paneId);
    await host().until("suspended", () => d.phase(paneId) === "suspended" && d.settled());
    expect(d.runtime.orchestrator.getView().specs[paneId]).toBeUndefined();
    expect(answersTo(commandId(host(), "retire"))).toHaveLength(1);
  });

  it("asks the machine to move a member whose folder is gone onto the root's team, writing nothing itself", async () => {
    let d = await open();
    const { ws } = await d.agentUp();
    const root = d.workspace().teams?.[0]?.id;
    const folder = join(host().work, "service");
    mkdirSync(folder);
    const paneId = await d.addAgent({ role: "lead", site: { kind: "existing", cwd: folder } });
    const session = await d.upAndBound(paneId);
    await host().until("on disk", () => readFileSync(join(host().home, "deck.json"), "utf8").includes(session));
    d.dispose();
    rmSync(folder, { recursive: true, force: true });
    await host().relaunch("quit");
    d = deck = await startDeck(host());
    await host().until("its folder is gone, on its card", () => d.runtime.orchestrator.getView().blocked[paneId] === folder, 15_000);
    const own = d.pane(paneId).team?.teamId;
    const before = d.runtime.deckStore.getSnapshot().workspaces;
    void d.runtime.orchestrator.startFresh(ws.id, paneId, "reviewer");
    // Nothing of the page's own: the deck moves by the machine's commands.
    expect(d.runtime.deckStore.getSnapshot().workspaces).toBe(before);
    await host().until("asked of the machine", () => d.intents().some((intent) => intent.kind === "relocate"));
    expect(d.intents().find((intent) => intent.kind === "relocate")).toMatchObject({ workspace: ws.id, pane: paneId, root });
    await host().until("on the root's team, and up there", () => d.pane(paneId).team?.teamId === root && d.slot(paneId) === "live", 15_000);
    const launches = d.launches(paneId);
    // A new conversation, in the workspace's folder; its card says nothing
    // of the folder any more. The team whose folder went keeps its card.
    expect(launches[launches.length - 1]?.cwd).toBe(host().work);
    expect(launches[launches.length - 1]?.args).not.toContain("--resume");
    expect(d.pane(paneId).session?.id).not.toBe(session);
    expect(d.runtime.orchestrator.getView().blocked[paneId]).toBeUndefined();
    expect(d.workspace().teams?.map((team) => team.id)).toContain(own);
  });
});

/** The id of the first machine command of `kind` the page heard. */
function commandId(host: ReturnType<ReturnType<typeof useHost>>, kind: string): string {
  for (const { way, line } of host.tape) {
    if (way !== "← host" || !line.includes(`"kind":"${kind}"`)) continue;
    const commands: unknown = Reflect.get(Reflect.get(Reflect.get(Reflect.get(JSON.parse(line), "message"), "versioned"), "snapshot"), "commands");
    if (!Array.isArray(commands)) continue;
    const due: unknown = commands.find((entry: unknown) => typeof entry === "object" && entry !== null && JSON.stringify(Reflect.get(entry, "cmd")).includes(`"kind":"${kind}"`));
    if (typeof due === "object" && due !== null) return JSON.stringify(Reflect.get(due, "id"));
  }
  throw new Error(`no ${kind} command was heard`);
}
