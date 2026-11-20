/**
 * The page's one copy of the lifecycle machine's state: the newest snapshot
 * its channel brought, «forgotten» read off it through one accessor, and
 * the commands in it handed to their owners.
 *
 * A command is carried out once per app run, under its exact name: one the
 * machine asks again — a restored operation after the machine started over
 * — gets the answer it already had, not a second carrying-out. The answer
 * is apart from the carrying-out: it is sent, and sent again on its own
 * timer, for as long as its command stays in the snapshot — the machine
 * drops a command once it has its answer (a deck command, once the deck is
 * also saved), so an answer lost on the way is never the end of it.
 */
import { isForgotten, type OwnerRefusal, type WriteSource } from "../domain/lifecycle";
import type { CommandId } from "../ipc/generated/lifecycle/CommandId";
import type { Due } from "../ipc/generated/lifecycle/Due";
import type { Outcome } from "../ipc/generated/lifecycle/Outcome";
import type { Owner } from "../ipc/generated/lifecycle/Owner";
import type { Snapshot } from "../ipc/generated/lifecycle/Snapshot";
import type { Versioned } from "../ipc/generated/lifecycle/Versioned";

/** A data owner the machine commands: carries one command out with its own
 * actions and says how it went. Idempotent — a command asked again after an
 * app restart finds its work done and says so. A refusal is an outcome
 * (`ownerRefused`, a kind), not a throw. */
export interface CommandOwner {
  carry(due: Due): Promise<Outcome>;
}

export type CommandOwners = Record<Owner, CommandOwner>;

/** An owner's refusal, as the machine carries it back: its kind and data,
 * never words. */
export function ownerRefused(why: OwnerRefusal): Outcome {
  return { kind: "rejected", why };
}

export interface LifecycleSnapshotDeps {
  owners: CommandOwners;
  /** An owner's answer, to the machine. */
  answer(id: CommandId, outcome: Outcome): Promise<void>;
  /** What an owner's carrying-out threw: for the log, never for the person. */
  warn(message: string): void;
  /** The wait before an answer is sent again: the first, doubled each time
   * up to the last. */
  backoff?: { firstMs: number; maxMs: number };
}

export interface LifecycleSnapshot {
  /** The newest snapshot, or null before the first. */
  current(): Snapshot | null;
  subscribe(listener: () => void): () => void;
  /** Whether a write from `source` is refused now. Nothing is, before the
   * first snapshot: the machine has forgotten nothing it has said. */
  forgotten(source: WriteSource): boolean;
  /** A snapshot off the channel; an older one than held is let go. */
  receive(versioned: Versioned): void;
  /** The machine started over: its versions count from the start again. */
  restarted(): void;
}

const BACKOFF = { firstMs: 1_000, maxMs: 30_000 };

/** A command's exact name, as a key. */
function nameOf(id: CommandId): string {
  return `${id.op}:${id.index}`;
}

export function createLifecycleSnapshot(deps: LifecycleSnapshotDeps): LifecycleSnapshot {
  /** An owner's carrying-out that threw: the machine hears it failed; what
   * was thrown goes to the log. */
  function failed(command: Due, error: unknown): Outcome {
    deps.warn(`lifecycle: ${command.owner} failed to carry ${command.cmd.kind} out — ${error instanceof Error ? error.message : String(error)}`);
    return ownerRefused({ kind: "failed" });
  }

  const backoff = deps.backoff ?? BACKOFF;
  let held: Versioned | null = null;
  const listeners = new Set<() => void>();
  /** What owners answered this run, by command name. */
  const answered = new Map<string, Outcome>();
  const carrying = new Set<string>();
  /** The answers being sent, by command name: the next send's timer. */
  const sending = new Map<string, ReturnType<typeof setTimeout>>();

  const due = (name: string) => held?.snapshot.commands.some((command) => nameOf(command.id) === name) ?? false;

  function send(id: CommandId, outcome: Outcome, waitMs: number): void {
    const name = nameOf(id);
    deps.answer(id, outcome).catch(() => {
      // The timer below sends it again.
    });
    const timer = setTimeout(() => {
      if (due(name)) send(id, outcome, Math.min(waitMs * 2, backoff.maxMs));
      else sending.delete(name);
    }, waitMs);
    sending.set(name, timer);
  }

  function answer(id: CommandId, outcome: Outcome): void {
    const name = nameOf(id);
    answered.set(name, outcome);
    if (due(name) && !sending.has(name)) send(id, outcome, backoff.firstMs);
  }

  function carry(command: Due): void {
    const name = nameOf(command.id);
    const outcome = answered.get(name);
    if (outcome) {
      answer(command.id, outcome);
      return;
    }
    if (carrying.has(name)) return;
    carrying.add(name);
    let carried: Promise<Outcome>;
    try {
      carried = deps.owners[command.owner].carry(command);
    } catch (error) {
      carried = Promise.resolve(failed(command, error));
    }
    void carried
      .catch((error: unknown) => failed(command, error))
      .then((outcome) => {
        carrying.delete(name);
        answer(command.id, outcome);
      });
  }

  return {
    current: () => held?.snapshot ?? null,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    forgotten: (source) => (held ? isForgotten(held.snapshot.forgotten, source) : false),
    receive(versioned) {
      if (held && versioned.version <= held.version) return;
      held = versioned;
      for (const [name, timer] of sending) {
        if (!due(name)) {
          clearTimeout(timer);
          sending.delete(name);
        }
      }
      for (const command of versioned.snapshot.commands) carry(command);
      for (const listener of listeners) listener();
    },
    restarted() {
      held = null;
    },
  };
}
