import type { Pane, Team, Workspace } from "../../domain/deck";
import type { CommandSource } from "../../domain/commands";
import { createWorkspaceInstance } from "../../domain/workspaceInstance";
import type { TasksStorePort } from "./tasksService";

/** A store in memory, with the writes and drops it saw in order. */
export function fakeStore(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const writes: { workspaceId: string; json: string }[] = [];
  /** Every call that touched the disk, in order. */
  const calls: ("write" | "drop")[] = [];
  let failNext: string | null = null;
  /** A write whose bytes land at once but whose answer waits. */
  let holdNext: Promise<void> | null = null;
  const port: TasksStorePort = {
    read: async ({ workspaceId }) => files.get(workspaceId) ?? null,
    write: async (args) => {
      if (failNext !== null) {
        const why = failNext;
        failNext = null;
        throw new Error(why);
      }
      writes.push(args);
      calls.push("write");
      files.set(args.workspaceId, args.json);
      if (holdNext !== null) {
        const held = holdNext;
        holdNext = null;
        await held;
      }
    },
    drop: async ({ workspaceId }) => {
      calls.push("drop");
      files.delete(workspaceId);
    },
  };
  return {
    port,
    files,
    writes,
    calls,
    failNextWrite(why: string) {
      failNext = why;
    },
    /** The next write's bytes land, but its answer waits for the release. */
    holdNextWrite(): () => void {
      let release!: () => void;
      holdNext = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

export const pane = (id: string, team?: { teamId: string; role: string }): Pane => ({
  id,
  agentType: "claude",
  ...(team && { team }),
});

export const workspace = (id: string, name: string, panes: Pane[], teams?: Team[]): Workspace =>
  ({
    id,
    instance: createWorkspaceInstance(),
    name,
    cwd: "/repo",
    worktreeBaseDir: null,
    panes,
    ...(teams && { teams }),
  }) as Workspace;

export const TEAMS: Team[] = [
  { id: "team-1", name: "api", location: { kind: "attached", cwd: "/repo/.wt/api" } },
  { id: "team-2", name: "web", location: { kind: "attached", cwd: "/repo/.wt/web" } },
];

/** ws-1: team api = pane-1 lead, pane-2 impl-1, pane-3 impl-2; team web =
 * pane-5 lead; pane-7 on no team. ws-2 holds pane-9 alone. */
export function teamedWorkspaces(): Workspace[] {
  return [
    workspace(
      "ws-1",
      "keepdeck",
      [
        pane("pane-1", { teamId: "team-1", role: "lead" }),
        pane("pane-2", { teamId: "team-1", role: "impl-1" }),
        pane("pane-3", { teamId: "team-1", role: "impl-2" }),
        pane("pane-5", { teamId: "team-2", role: "lead" }),
        pane("pane-7"),
      ],
      TEAMS,
    ),
    workspace("ws-2", "site", [pane("pane-9")]),
  ];
}

/** A caller identified as a pane, the way the MCP transport mints it. */
export function from(paneId: string, workspaceId = "ws-1"): CommandSource {
  return { kind: "external", client: "mcp", pane: { id: paneId, workspaceId, label: paneId } };
}

export const ANONYMOUS: CommandSource = { kind: "external", client: "mcp" };
