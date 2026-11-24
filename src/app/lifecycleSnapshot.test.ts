import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandId } from "../ipc/generated/lifecycle/CommandId";
import type { Due } from "../ipc/generated/lifecycle/Due";
import { dues, versioned } from "../ipc/generated/lifecycle/examples";
import type { Outcome } from "../ipc/generated/lifecycle/Outcome";
import type { Owner } from "../ipc/generated/lifecycle/Owner";
import type { Versioned } from "../ipc/generated/lifecycle/Versioned";
import { createLifecycleSnapshot, type CommandOwners } from "./lifecycleSnapshot";

const BACKOFF = { firstMs: 100, maxMs: 400 };
const APPLIED: Outcome = { kind: "applied", revision: null };

/** The example snapshot at `version`, owing exactly `commands`. */
function at(version: number, commands: Due[], forgotten = versioned.snapshot.forgotten): Versioned {
  return { version, snapshot: { ...versioned.snapshot, forgotten, commands } };
}

/** Owners that record what they carried and answer each as told. */
function owners(outcome: (due: Due) => Promise<Outcome> = () => Promise.resolve(APPLIED)) {
  const carried: Due[] = [];
  const owner = { carry: vi.fn((due: Due) => (carried.push(due), outcome(due))) };
  const every: CommandOwners = { deck: owner, boards: owner, mail: owner, runState: owner, notices: owner, forkStep: owner };
  return { every, carried, owner };
}

function rig(outcome?: (due: Due) => Promise<Outcome>) {
  const { every, carried } = owners(outcome);
  const answers: [CommandId, Outcome][] = [];
  const answer = vi.fn((id: CommandId, given: Outcome) => (answers.push([id, given]), Promise.resolve()));
  const warn = vi.fn();
  const hookEnded = vi.fn((_op: number) => Promise.resolve());
  const store = createLifecycleSnapshot({ owners: every, answer, hookEnded, backoff: BACKOFF, warn });
  return { store, carried, answers, answer, hookEnded, warn };
}

const removePane = dues.find((due) => due.cmd.kind === "removePane");
const forgetMail = dues.find((due) => due.cmd.kind === "forgetPaneMail");
if (!removePane || !forgetMail) throw new Error("the examples carry every command");

describe("the lifecycle snapshot", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps the newest version and lets an older one go", () => {
    const { store } = rig();
    const seen = vi.fn();
    store.subscribe(seen);
    store.receive(at(5, []));
    store.receive(at(4, [removePane]));
    expect(store.current()?.commands).toEqual([]);
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("reads «forgotten» off the newest snapshot, and nothing before the first", () => {
    const { store } = rig();
    const pane9 = { workspace: "ws-a", pane: "pane-9" };
    expect(store.forgotten(pane9)).toBe(false);
    store.receive(at(1, [], { workspaces: [], teams: [], panes: ["pane-9"] }));
    expect(store.forgotten(pane9)).toBe(true);
  });

  it("hands each command to its own owner once, however often the snapshot names it", async () => {
    const { store, carried } = rig();
    store.receive(at(1, [removePane, forgetMail]));
    store.receive(at(2, [removePane, forgetMail]));
    await vi.runOnlyPendingTimersAsync();
    expect(carried.map((due) => [due.cmd.kind, due.owner])).toEqual([
      ["removePane", "deck" satisfies Owner],
      ["forgetPaneMail", "mail" satisfies Owner],
    ]);
  });

  it("sends an answer again on its own timer while its command stays, and stops once it is gone", async () => {
    const { store, answer } = rig();
    store.receive(at(1, [removePane]));
    await vi.advanceTimersByTimeAsync(0);
    expect(answer).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(BACKOFF.firstMs);
    expect(answer).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(BACKOFF.firstMs * 2);
    expect(answer).toHaveBeenCalledTimes(3);
    // Doubled up to the last wait, no further.
    await vi.advanceTimersByTimeAsync(BACKOFF.maxMs);
    await vi.advanceTimersByTimeAsync(BACKOFF.maxMs);
    expect(answer).toHaveBeenCalledTimes(5);
    store.receive(at(2, []));
    await vi.advanceTimersByTimeAsync(BACKOFF.maxMs * 4);
    expect(answer).toHaveBeenCalledTimes(5);
  });

  it("answers an owner that failed with the failed kind, and logs what it threw — never words for the person", async () => {
    const { store, answers, warn } = rig(() => Promise.reject(new Error("the deck could not take it")));
    store.receive(at(1, [removePane]));
    await vi.advanceTimersByTimeAsync(0);
    expect(answers[0]?.[1]).toEqual({ kind: "rejected", why: { kind: "failed" } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("the deck could not take it"));
  });

  it("sends a lost answer again", async () => {
    const { store, answer } = rig();
    answer.mockImplementationOnce(() => Promise.reject(new Error("ipc down")));
    store.receive(at(1, [removePane]));
    await vi.advanceTimersByTimeAsync(BACKOFF.firstMs);
    expect(answer).toHaveBeenCalledTimes(2);
  });

  // A command's id names a command only in its own machine's life: an answer
  // that outlived the runtime would answer another command of the next one.
  it("sends nothing once disposed, and leaves no timer to send it", async () => {
    const { store, answer } = rig();
    store.receive(at(1, [removePane]));
    await vi.advanceTimersByTimeAsync(0);
    expect(answer).toHaveBeenCalledTimes(1);
    store.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(BACKOFF.maxMs * 4);
    expect(answer).toHaveBeenCalledTimes(1);
  });

  it("drops the answer of a carry that ends after the dispose, and carries nothing it hears after", async () => {
    let finish: (outcome: Outcome) => void = () => {};
    const { store, carried, answer } = rig(() => new Promise((resolve) => (finish = resolve)));
    store.receive(at(1, [removePane]));
    store.dispose();
    finish(APPLIED);
    await vi.advanceTimersByTimeAsync(BACKOFF.maxMs * 4);
    expect(answer).not.toHaveBeenCalled();
    store.receive(at(2, [removePane, forgetMail]));
    expect(carried.map((due) => due.cmd.kind)).toEqual(["removePane"]);
  });

  it("tells the machine a fork hook ended while it lives — a failed report to the log — and nothing once disposed", async () => {
    const { store, hookEnded, warn } = rig();
    hookEnded.mockImplementationOnce(() => Promise.reject(new Error("ipc down")));
    store.hookEnded(4);
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ipc down"));
    store.hookEnded(5);
    store.dispose();
    store.hookEnded(6);
    expect(hookEnded.mock.calls.map(([op]) => op)).toEqual([4, 5]);
  });
});
