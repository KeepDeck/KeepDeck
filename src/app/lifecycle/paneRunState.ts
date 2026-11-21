/**
 * PaneRunState: the launch state the lifecycle machine commands — a pane's
 * plan, built for one attempt, and what the machine asks of it. It keeps
 * the plans and the fork's scaffolding as the spawn-plan cache always has;
 * it decides nothing about when scaffolding goes, how long a fork may take,
 * or whether a launch is bound. Those are the machine's, and the binding
 * lane's.
 *
 * - A continued pane's plan — a fork's, a resume's — is built for its
 *   attempt (the operation's id). When the machine drops that attempt, its
 *   plan goes, and a build that lands after is refused — never installed for
 *   a launch nobody will make.
 * - The fork step only calls the plugin's hook and says how it went: the
 *   scaffolding it declared, or why not. That the call ended is said every
 *   time, in time or late, so the machine knows when the hook can no longer
 *   write.
 * - Whether a fork's launch is bound is the binding lane's verdict: the
 *   first binding it accepts for the pane, before or after the question.
 */
import type { Discard } from "../../ipc/generated/lifecycle/Discard";
import type { Outcome } from "../../ipc/generated/lifecycle/Outcome";
import type { SessionKey } from "../../ipc/generated/lifecycle/SessionKey";
import { ownerRefused, type CommandOwner } from "../lifecycleSnapshot";

export interface RunStatePorts {
  /** Build the fork plan of `pane` from `source`, into `cwd`, through the
   * plugin's fork hook — the scaffolding it declared, under its plugin. */
  buildFork(args: { workspace: string; pane: string; source: SessionKey; cwd: string }): Promise<Discard>;
  /** Build the plan that resumes `source` in `pane`. */
  buildResume(args: { workspace: string; pane: string; source: SessionKey }): Promise<void>;
  /** End a pane's plan and the secrets in it; a build still running for it
   * lands nowhere. */
  dropPlan(pane: string): void;
  /** Let go of what the page holds for a pane's process, now that it is
   * over: its session slot, and — for a process replaced in place — the
   * terminal it was shown in. */
  letGo(args: { workspace: string; pane: string; replacedInPlace: boolean }): Promise<void>;
  /** The bindings the binding lane accepted. */
  bindings: { subscribe(listener: (bound: { paneId: string }) => void): () => void };
  /** Tell the machine the fork step's hook call has ended. */
  hookEnded(op: number): void;
}

export interface PaneRunState {
  /** The owner of the launch-state commands. */
  runState: CommandOwner;
  /** The owner of the fork step. */
  forkStep: CommandOwner;
}

const DONE: Outcome = { kind: "applied", revision: null };

export function createPaneRunState(ports: RunStatePorts): PaneRunState {
  /** Each build's pane, by the operation's id. */
  const attempts = new Map<number, string>();
  /** Attempts the machine dropped. */
  const dropped = new Set<number>();
  /** Panes the binding lane bound, and the questions waiting on one. */
  const bound = new Set<string>();
  const waiting = new Map<string, (() => void)[]>();
  ports.bindings.subscribe(({ paneId }) => {
    bound.add(paneId);
    for (const answer of waiting.get(paneId) ?? []) answer();
    waiting.delete(paneId);
  });

  function whenBound(pane: string): Promise<void> {
    if (bound.has(pane)) return Promise.resolve();
    return new Promise((resolve) => waiting.set(pane, [...(waiting.get(pane) ?? []), resolve]));
  }

  /** Build `pane`'s plan for attempt `op`. Built for an attempt the machine
   * already dropped, its plan goes again, never to be spawned; what the
   * build hands back still goes to the machine. */
  async function buildFor<T>(op: number, pane: string, build: () => Promise<T>): Promise<T> {
    attempts.set(op, pane);
    const built = await build();
    if (dropped.has(op)) ports.dropPlan(pane);
    return built;
  }

  const runState: CommandOwner = {
    async carry({ id, cmd }) {
      switch (cmd.kind) {
        case "retire":
          ports.dropPlan(cmd.pane);
          return DONE;
        case "release":
          await ports.letGo({ workspace: cmd.workspace, pane: cmd.pane, replacedInPlace: cmd.inPlace });
          return DONE;
        case "prepareResume":
          await buildFor(id.op, cmd.pane, () => ports.buildResume({ workspace: cmd.workspace, pane: cmd.pane, source: cmd.source }));
          return DONE;
        case "dropBuild": {
          dropped.add(cmd.op);
          const pane = attempts.get(cmd.op);
          if (pane !== undefined) ports.dropPlan(pane);
          return DONE;
        }
        case "reportBinding":
          await whenBound(cmd.pane);
          return DONE;
        default:
          return ownerRefused({ kind: "wrongOwner", command: cmd.kind });
      }
    },
  };

  const forkStep: CommandOwner = {
    async carry({ id, cmd }) {
      if (cmd.kind !== "fork") return ownerRefused({ kind: "wrongOwner", command: cmd.kind });
      // What the hook made, even for a dropped attempt, is still there: the
      // machine's rollback takes it back from these lists.
      let discard: Discard;
      try {
        discard = await buildFor(id.op, cmd.pane, () => ports.buildFork({ workspace: cmd.workspace, pane: cmd.pane, source: cmd.source, cwd: cmd.cwd }));
      } finally {
        ports.hookEnded(id.op);
      }
      return { kind: "forked", discard };
    },
  };

  return { runState, forkStep };
}
