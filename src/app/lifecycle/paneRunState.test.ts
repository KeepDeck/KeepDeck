import { describe, expect, it, vi } from "vitest";
import type { Cmd } from "../../ipc/generated/lifecycle/Cmd";
import type { Discard } from "../../ipc/generated/lifecycle/Discard";
import type { Outcome } from "../../ipc/generated/lifecycle/Outcome";
import type { CommandOwner } from "../lifecycleSnapshot";
import type { Built } from "./continuationPlans";
import { createPaneRunState, type RunStatePorts } from "./paneRunState";

const SOURCE = { agent: "claude", session: "s-1" };
const DRAFT = { agentType: "claude", role: "impl-1", yolo: true };
const DISCARD: Discard = { plugin: "keepdeck.claude", onceStarted: ["/kd/spec"], ifNeverStarted: ["/c/fork.jsonl"] };
const fork: Cmd = { kind: "fork", workspace: "ws-a", pane: "pane-7", source: SOURCE, cwd: "/repo", draft: DRAFT };
const BUILT: Built<null> = { kind: "built", value: null };

function rig(build: () => Promise<Built<Discard>> = () => Promise.resolve({ kind: "built", value: DISCARD })) {
  let accept: (bound: { paneId: string }) => void = () => {};
  const ports: RunStatePorts = {
    buildFork: vi.fn(build),
    buildResume: vi.fn(() => Promise.resolve(BUILT)),
    dropPlan: vi.fn(),
    letGo: vi.fn(() => Promise.resolve()),
    bindings: {
      subscribe(listener) {
        accept = listener;
        return () => {};
      },
    },
    hookEnded: vi.fn(),
  };
  const { runState, forkStep } = createPaneRunState(ports);
  const carry = (owner: CommandOwner, cmd: Cmd, op = 3): Promise<Outcome> => owner.carry({ id: { op, index: 0 }, owner: "runState", cmd });
  return { ports, runState, forkStep, carry, bind: (paneId: string) => accept({ paneId }) };
}

describe("the pane's run state, as the machine commands it", () => {
  it("calls the fork hook, hands back the scaffolding it declared, and says the call ended", async () => {
    const { ports, forkStep, carry } = rig();
    expect(await carry(forkStep, fork)).toEqual({ kind: "forked", discard: DISCARD });
    expect(ports.hookEnded).toHaveBeenCalledWith(3);
  });

  it("says the call ended when the hook failed, too", async () => {
    const { ports, forkStep, carry } = rig(() => Promise.reject(new Error("store layout changed")));
    await expect(carry(forkStep, fork)).rejects.toThrow("store layout changed");
    expect(ports.hookEnded).toHaveBeenCalledWith(3);
  });

  it("hands the build its own ask's draft, and gives the machine a build's refusal as the owner's", async () => {
    const { ports, runState, forkStep, carry } = rig(() => Promise.resolve({ kind: "refused", why: { kind: "notAsked" } }));
    expect(await carry(forkStep, fork)).toEqual({ kind: "rejected", why: { kind: "notAsked" } });
    expect(ports.buildFork).toHaveBeenCalledWith({ workspace: "ws-a", pane: "pane-7", source: SOURCE, cwd: "/repo", draft: DRAFT });
    expect(ports.hookEnded).toHaveBeenCalledWith(3);
    vi.mocked(ports.buildResume).mockResolvedValue({ kind: "refused", why: { kind: "unreadable", what: "agent" } });
    expect(await carry(runState, { kind: "prepareResume", workspace: "ws-a", pane: "pane-2", source: SOURCE, draft: null })).toEqual({
      kind: "rejected",
      why: { kind: "unreadable", what: "agent" },
    });
  });

  it("drops a dropped attempt's plan, and still hands back what its late build made", async () => {
    let finish: (built: Built<Discard>) => void = () => {};
    const { ports, runState, forkStep, carry } = rig(() => new Promise((resolve) => (finish = resolve)));
    const forking = carry(forkStep, fork);
    expect(await carry(runState, { kind: "dropBuild", op: 3 })).toEqual({ kind: "applied", revision: null });
    expect(ports.dropPlan).toHaveBeenCalledWith("pane-7");
    finish({ kind: "built", value: DISCARD });
    // The plan goes again, never spawned; the lists go to the machine, whose
    // rollback takes back what the hook made.
    expect(await forking).toEqual({ kind: "forked", discard: DISCARD });
    expect(ports.dropPlan).toHaveBeenCalledTimes(2);
    expect(ports.hookEnded).toHaveBeenCalledWith(3);
  });

  it("drops a resume's plan the machine dropped for its deadline, and again when its late build lands", async () => {
    let finish = () => {};
    const { ports, runState, carry } = rig();
    vi.mocked(ports.buildResume).mockReturnValue(new Promise<Built<null>>((resolve) => (finish = () => resolve(BUILT))));
    const preparing = carry(runState, { kind: "prepareResume", workspace: "ws-a", pane: "pane-2", source: SOURCE, draft: DRAFT }, 5);
    await carry(runState, { kind: "dropBuild", op: 5 });
    expect(ports.dropPlan).toHaveBeenCalledWith("pane-2");
    finish();
    expect(await preparing).toEqual({ kind: "applied", revision: null });
    expect(ports.dropPlan).toHaveBeenCalledTimes(2);
  });

  it("answers whether a launch is bound with the binding lane's verdict, before the question or after", async () => {
    const { runState, carry, bind } = rig();
    bind("pane-1");
    expect(await carry(runState, { kind: "reportBinding", workspace: "ws-a", pane: "pane-1", op: 3 })).toEqual({ kind: "applied", revision: null });
    let answered = false;
    const asked = carry(runState, { kind: "reportBinding", workspace: "ws-a", pane: "pane-2", op: 4 }).then(() => (answered = true));
    await Promise.resolve();
    expect(answered).toBe(false);
    bind("pane-2");
    await asked;
    expect(answered).toBe(true);
  });

  it("retires a pane's plan and prepares a resumed one", async () => {
    const { ports, runState, carry } = rig();
    await carry(runState, { kind: "retire", workspace: "ws-a", pane: "pane-1" });
    expect(ports.dropPlan).toHaveBeenCalledWith("pane-1");
    await carry(runState, { kind: "prepareResume", workspace: "ws-a", pane: "pane-2", source: SOURCE, draft: DRAFT });
    expect(ports.buildResume).toHaveBeenCalledWith({ workspace: "ws-a", pane: "pane-2", source: SOURCE, draft: DRAFT });
    expect((await carry(runState, fork)).kind).toBe("rejected");
  });

  it("lets go of a stopped pane's process as the machine says, and answers once it has", async () => {
    // The answer waits for the letting go: the machine's operation is not
    // over until the slot a next launch would find taken is empty.
    let done = () => {};
    const { ports, runState, carry } = rig();
    vi.mocked(ports.letGo).mockReturnValue(new Promise<void>((resolve) => (done = resolve)));
    let answered = false;
    const carried = carry(runState, { kind: "release", workspace: "ws-a", pane: "pane-1", inPlace: true }).then((outcome) => {
      answered = true;
      return outcome;
    });
    await Promise.resolve();
    expect(ports.letGo).toHaveBeenCalledWith({ workspace: "ws-a", pane: "pane-1", replacedInPlace: true });
    expect(answered).toBe(false);
    done();
    expect(await carried).toEqual({ kind: "applied", revision: null });
  });
});
