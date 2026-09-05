// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../domain/workspaceInstance";
import type { Workspace } from "../domain/deck/workspaces";
import type { SessionRecord } from "../domain/journal";
import { useWorkspaceScope } from "./useWorkspaceScope";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const ws = (over: Partial<Workspace>): Workspace => ({
  id: "ws-1",
  instance: createWorkspaceInstance(),
  name: "web",
  cwd: "/repo",
  worktreeBaseDir: null,
  panes: [],
  ...over,
});

const record = (cwd: string): SessionRecord =>
  ({
    agent: "claude",
    sessionId: `s-${cwd}`,
    cwd,
    boundAt: "2026-07-19T10:00:00.000Z",
    state: "closed",
    endedAt: "2026-07-19T11:00:00:00Z".replace(":00:00:", ":00:00:"),
  }) as SessionRecord;

/** A pane for the workspace fixture — the provisioning shape carries no
 * resolved cwd; a real one may. */
const pane = (over: {
  provisioning: boolean;
  cwd: string | null;
}): Workspace["panes"][number] =>
  ({
    id: "pane-1",
    agentType: "claude",
    ...(over.provisioning
      ? {
          location: {
            kind: "provisioning",
            intent: { repo: "/repo", path: "/wt/a", index: 1 },
          },
        }
      : over.cwd !== null
        ? { location: { kind: "attached", cwd: over.cwd } }
        : {}),
  }) as Workspace["panes"][number];

let dirs: ReadonlySet<string>;

function Probe({ ws, records }: { ws: Workspace; records: SessionRecord[] }) {
  dirs = useWorkspaceScope(ws, records);
  return null;
}

describe("useWorkspaceScope — a SEMANTIC version of the scope", () => {
  let root: Root;
  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => act(() => root.unmount()));

  const render = (ws: Workspace, records: SessionRecord[]) =>
    act(async () => root.render(createElement(Probe, { ws, records })));

  it("TOO STABLE is impossible: same content through FRESH containers keeps the SAME Set identity", async () => {
    // The bug this hook once shipped: the deck rebuilds its arrays on
    // ANY journal event — including another workspace's — and a fresh
    // array read as a scope change, blanking the screen and re-asking
    // the index. Semantic identity: fresh workspace object, fresh rows
    // array, SAME content → SAME Set by reference.
    await render(ws({}), [record("/hist")]);
    const first = dirs;
    // Fresh containers, same content (the "other workspace's journal
    // event" shape: the observed workspace's own data did not move).
    await render(ws({}), [record("/hist")]);
    expect(dirs).toBe(first);
  });

  it("TOO MOBILE is impossible: a REAL content change produces a NEW Set", async () => {
    // The opposite failure: clinging to the old identity when the scope
    // truly grew would silence the scope-change effect — the commit-1
    // disease back through the supply chain.
    await render(ws({}), [record("/hist")]);
    const first = dirs;
    await render(ws({}), [record("/hist"), record("/new-folder")]);
    expect(dirs).not.toBe(first);
    expect([...dirs].sort()).toEqual(["/hist", "/new-folder", "/repo"]);
  });

  it("the KEY rides the RULE's result: an empty journal cwd is dropped by both alike", async () => {
    // The fingerprint is derived from workspaceScopeDirectories's OUTPUT,
    // not a parallel formula over inputs — so whatever the rule drops,
    // the key drops too. An empty cwd is the reachable case: the rule
    // refuses it, and a scope that differs ONLY by it must keep the
    // same identity (a parallel key over raw inputs would disagree and
    // fire a spurious reset).
    await render(ws({}), [record("/hist"), record("")]);
    const first = dirs;
    await render(ws({}), [record("/hist")]);
    expect(dirs).toBe(first); // the empty cwd moved nothing
    expect([...dirs].sort()).toEqual(["/hist", "/repo"]);
  });

  it("row 3: a provisioning pane without cwd does NOT move the identity", async () => {
    // The rule (workspaceDirectories) refuses a provisioning pane's
    // unresolved cwd; the fingerprint rides the RULE's result — so the
    // hook's contract's future case is pinned NOW: the pane appears,
    // the identity holds.
    await render(ws({ panes: [] }), [record("/hist")]);
    const first = dirs;
    await render(
      ws({ panes: [pane({ provisioning: true, cwd: null })] }),
      [record("/hist")],
    );
    expect(dirs).toBe(first);
    expect([...dirs].sort()).toEqual(["/hist", "/repo"]);
  });

  it("row 4: a REAL pane cwd DOES move the identity", async () => {
    await render(ws({ panes: [] }), [record("/hist")]);
    const first = dirs;
    await render(
      ws({ panes: [pane({ provisioning: false, cwd: "/wt/pane-root" })] }),
      [record("/hist")],
    );
    expect(dirs).not.toBe(first);
    expect([...dirs].sort()).toEqual(["/hist", "/repo", "/wt/pane-root"]);
  });
});
