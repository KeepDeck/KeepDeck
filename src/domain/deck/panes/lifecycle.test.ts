import { describe, expect, it } from "vitest";
import {
  paneBlock,
  paneCanPark,
  paneCanSuspend,
  paneHasProcess,
  paneIdleIsDurable,
  paneIsRemoteFresh,
  idleReadsAsStopped,
  paneSuspendBlock,
  paneResumeSessionId,
  paneWakeOrigin,
  paneWakesAutomatically,
  sessionClaimant,
  type Pane,
} from ".";

describe("paneIsRemoteFresh", () => {
  it("true only for a pane with a non-empty remote endpoint", () => {
    expect(paneIsRemoteFresh({ id: "p", remoteEndpoint: "ws://vps:4500" })).toBe(true);
    // Absent endpoint → local.
    expect(paneIsRemoteFresh({ id: "p" })).toBe(false);
    // Truthy, not `!== undefined`: an empty string is a non-remote degenerate
    // case (hand-edit only — the dialog never sets "") so lifecycle + plan
    // builder agree it's local.
    expect(paneIsRemoteFresh({ id: "p", remoteEndpoint: "" })).toBe(false);
  });
});

describe("paneHasProcess", () => {
  it("false for every reason a pane has none, true only for a plain pane", () => {
    expect(paneHasProcess({ id: "p" })).toBe(true);
    // Exited is still "has a process" to the model: the marker is runtime
    // state the durable shape deliberately doesn't carry.
    expect(paneHasProcess({ id: "p", session: { id: "s", boundAt: "t" } })).toBe(
      true,
    );
    // Every idle reason, including the one on its way UP — a rising pane has
    // no session YET, which is what the telemetry lanes need to know.
    expect(paneHasProcess({ id: "p", idle: { reason: "parked" } })).toBe(false);
    expect(
      paneHasProcess({ id: "p", idle: { reason: "suspended", at: "t" } }),
    ).toBe(false);
    expect(
      paneHasProcess({ id: "p", idle: { reason: "waking", origin: "manual" } }),
    ).toBe(false);
    // The half the limits poller used to drop: mid-create, never ran.
    expect(
      paneHasProcess({
        id: "p",
        provisioning: { repo: "/repo", workspace: "ws", index: 1 },
      }),
    ).toBe(false);
  });
});

describe("paneCanSuspend", () => {
  it("true for a running pane, and for one whose process already exited", () => {
    // Exit is runtime state the durable model doesn't carry, so an exited pane
    // is indistinguishable here — deliberately: parking a dead agent is
    // meaningful, its card just becomes the honest stopped one.
    expect(paneCanSuspend({ id: "p" }, false)).toBe(true);
    expect(
      paneCanSuspend({ id: "p", session: { id: "s", boundAt: "t" } }, false),
    ).toBe(true);
  });

  it("false only for a pane already STAYING down", () => {
    expect(paneCanSuspend({ id: "p", idle: { reason: "parked" } }, false)).toBe(
      false,
    );
    expect(
      paneCanSuspend({ id: "p", idle: { reason: "suspended", at: "t" } }, false),
    ).toBe(false);
  });

  it("true for a pane on its way up — stopping it cancels the wake", () => {
    // Panes in a workspace the user isn't looking at stay `waking` until it is
    // activated; refusing them made those agents impossible to park.
    expect(
      paneCanSuspend(
        { id: "p", idle: { reason: "waking", origin: "restore" } },
        false,
      ),
    ).toBe(true);
    expect(
      paneCanSuspend(
        { id: "p", idle: { reason: "waking", origin: "manual" } },
        false,
      ),
    ).toBe(true);
  });

  it("names the reason it refuses, so every surface says the same thing", () => {
    expect(paneSuspendBlock({ id: "p" }, false)).toBeNull();
    expect(paneSuspendBlock({ id: "p", idle: { reason: "parked" } }, false)).toBe(
      "stopped",
    );
    expect(
      paneSuspendBlock(
        { id: "p", provisioning: { repo: "/r", workspace: "w", index: 1 } },
        false,
      ),
    ).toBe("provisioning");
    expect(
      paneSuspendBlock({ id: "p", remoteEndpoint: "ws://vps:4500" }, false),
    ).toBe("remote");
    // Precedence matters: it decides which sentence the user reads.
    expect(
      paneSuspendBlock(
        {
          id: "p",
          idle: { reason: "parked" },
          remoteEndpoint: "ws://vps:4500",
        },
        false,
      ),
    ).toBe("stopped");
  });

  it("refuses a RISING pane once the sweep reports its folder gone", () => {
    // The block is runtime state the model can't see, so it arrives as an
    // argument — the same one `idleReadsAsStopped` takes, so the dialog, the
    // tile and the tray cannot disagree about which panes are dead.
    const rising = {
      id: "p",
      idle: { reason: "waking", origin: "restore" },
    } as const;
    expect(paneSuspendBlock(rising, false)).toBeNull();
    expect(paneSuspendBlock(rising, true)).toBe("stopped");
    // A LIVE pane is never stopped by a stale entry: it has no idle marker,
    // and a running agent is not "already stopped" whatever the map says.
    expect(paneSuspendBlock({ id: "p" }, true)).toBeNull();
    // Already-down panes answer the same with or without a block — the
    // argument can only ADD a reason to refuse, never remove one.
    for (const idle of [
      { reason: "parked" },
      { reason: "suspended", at: "t" },
    ] as const) {
      expect(paneSuspendBlock({ id: "p", idle }, false)).toBe("stopped");
      expect(paneSuspendBlock({ id: "p", idle }, true)).toBe("stopped");
    }
  });

  it("false while a worktree create is in flight — no process to stop", () => {
    expect(
      paneCanSuspend(
        { id: "p", provisioning: { repo: "/r", workspace: "w", index: 1 } },
        false,
      ),
    ).toBe(false);
  });

  it("false for a REMOTE pane — its conversation lives on the server", () => {
    expect(
      paneCanSuspend({ id: "p", remoteEndpoint: "ws://vps:4500" }, false),
    ).toBe(false);
  });
});

describe("paneIdleIsDurable", () => {
  it("names the one reason that reaches disk", () => {
    // Asked in two layers — the codec decides what to WRITE, the save
    // scheduler decides what may not wait for a debounce — and they were two
    // copies of one literal. A fifth durable reason added to the codec alone
    // would still be saved, but only on the timer, so a quit inside that
    // window would lose it.
    expect(paneIdleIsDurable({ reason: "suspended", at: "t" })).toBe(true);
    expect(paneIdleIsDurable({ reason: "parked" })).toBe(false);
    expect(paneIdleIsDurable({ reason: "waking", origin: "restore" })).toBe(false);
    expect(paneIdleIsDurable({ reason: "waking", origin: "manual" })).toBe(false);
    expect(paneIdleIsDurable(undefined)).toBe(false);
  });
});

describe("paneWakeOrigin / paneWakesAutomatically", () => {
  it("names WHO asked, and answers null when nobody is bringing the pane up", () => {
    // The accessor exists so the sweep never re-derives the origin with a
    // `: "restore"` fallback: that fallback would hand a future auto-waking
    // reason the one origin allowed to become a different conversation.
    expect(
      paneWakeOrigin({ id: "p", idle: { reason: "waking", origin: "restore" } }),
    ).toBe("restore");
    expect(
      paneWakeOrigin({ id: "p", idle: { reason: "waking", origin: "manual" } }),
    ).toBe("manual");
    expect(paneWakeOrigin({ id: "p", idle: { reason: "parked" } })).toBeNull();
    expect(
      paneWakeOrigin({ id: "p", idle: { reason: "suspended", at: "t" } }),
    ).toBeNull();
    expect(paneWakeOrigin({ id: "p" })).toBeNull();
  });

  it("agrees with the predicate the sweep guards on", () => {
    for (const idle of [
      undefined,
      { reason: "waking", origin: "restore" },
      { reason: "waking", origin: "manual" },
      { reason: "parked" },
      { reason: "suspended", at: "t" },
    ] as const) {
      const pane = { id: "p", ...(idle && { idle }) };
      expect(paneWakeOrigin(pane) !== null).toBe(paneWakesAutomatically(pane));
    }
  });

  it("a live pane is not the sweep's business", () => {
    expect(paneWakesAutomatically({ id: "p" })).toBe(false);
    expect(paneWakesAutomatically({ id: "p", idle: { reason: "waking", origin: "restore" } })).toBe(
      true,
    );
    expect(
      paneWakesAutomatically({ id: "p", idle: { reason: "suspended", at: "t" } }),
    ).toBe(false);
  });
});

describe("idleReadsAsStopped", () => {
  it("true only when nothing is bringing the pane back on its own", () => {
    expect(idleReadsAsStopped(undefined, false)).toBe(false); // running
    expect(idleReadsAsStopped({ reason: "waking", origin: "restore" }, false)).toBe(false);
    expect(idleReadsAsStopped({ reason: "waking", origin: "manual" }, false)).toBe(false);
    expect(idleReadsAsStopped({ reason: "parked" }, false)).toBe(true);
    expect(idleReadsAsStopped({ reason: "suspended", at: "t" }, false)).toBe(true);
  });

  it("counts the sweep's gone-folder verdict as stopped too", () => {
    // A rising pane that will never rise. This is the whole reason the
    // predicate takes the verdict rather than deriving from the marker alone.
    expect(idleReadsAsStopped({ reason: "waking", origin: "restore" }, true)).toBe(true);
    // But a LIVE pane is not stopped by a stale entry.
    expect(idleReadsAsStopped(undefined, true)).toBe(false);
  });
});

describe("paneResumeSessionId", () => {
  it("is the binding, or null when the pane would start fresh", () => {
    expect(
      paneResumeSessionId({ id: "p", session: { id: "s-1", boundAt: "t" } }),
    ).toBe("s-1");
    expect(paneResumeSessionId({ id: "p" })).toBeNull();
  });

  it("is null for a remote pane even when a stale binding clings to it", () => {
    // Resuming that id locally would be a different conversation from the one
    // living on the server.
    expect(
      paneResumeSessionId({
        id: "p",
        remoteEndpoint: "ws://vps:4500",
        session: { id: "stale", boundAt: "t" },
      }),
    ).toBeNull();
  });
});

describe("paneBlock — the head both ladders share", () => {
  it("answers nothing for an ordinary pane", () => {
    expect(paneBlock({ id: "p1", agentType: "claude" }, true)).toBeNull();
  });

  it("puts provisioning first — nothing else can be acted on", () => {
    expect(
      paneBlock(
        {
          id: "p1",
          idle: { reason: "parked" },
          provisioning: { repo: "/r", workspace: "w", index: 1 },
        },
        false,
      ),
    ).toEqual({ kind: "provisioning" });
  });

  it("names an absent agent over a stopped marker", () => {
    expect(
      paneBlock({ id: "p1", agentType: "codex", idle: { reason: "parked" } }, false),
    ).toEqual({ kind: "agent-unavailable", agent: "codex" });
  });

  it("carries the idle marker WHOLE, so a caller can put it back", () => {
    const idle = { reason: "suspended", at: "2026-07-27T10:00:00.000Z" } as const;
    expect(paneBlock({ id: "p1", idle }, true)).toEqual({
      kind: "stopped",
      by: idle,
    });
  });
});

describe("sessionClaimant", () => {
  const decks = (panes: Pane[]) => [{ panes }];
  const free = () => false;

  it("says nothing when no pane holds the session", () => {
    expect(sessionClaimant(decks([{ id: "p1" }]), "s-1", free)).toBeNull();
  });

  it("finds the holder across workspaces and calls a live one running", () => {
    const holder: Pane = { id: "p2", session: { id: "s-1", boundAt: "t" } };
    expect(
      sessionClaimant([{ panes: [{ id: "p1" }] }, { panes: [holder] }], "s-1", free),
    ).toEqual({ pane: holder, reads: "running" });
  });

  it("calls a suspended holder stopped — that pane has the button", () => {
    expect(
      sessionClaimant(
        decks([
          {
            id: "p1",
            idle: { reason: "suspended", at: "t" },
            session: { id: "s-1", boundAt: "t" },
          },
        ]),
        "s-1",
        free,
      )?.reads,
    ).toBe("stopped");
  });

  it("calls a RISING holder running — it will be, in a moment", () => {
    // Sending the user to resume a pane that is already coming up points at a
    // card with no button on it.
    expect(
      sessionClaimant(
        decks([
          {
            id: "p1",
            idle: { reason: "waking", origin: "restore" },
            session: { id: "s-1", boundAt: "t" },
          },
        ]),
        "s-1",
        free,
      )?.reads,
    ).toBe("running");
  });

  it("calls a rising holder STOPPED once the sweep says its folder is gone", () => {
    // Its own marker still says it is rising; only the runtime verdict knows
    // it never will.
    expect(
      sessionClaimant(
        decks([
          {
            id: "p1",
            idle: { reason: "waking", origin: "restore" },
            session: { id: "s-1", boundAt: "t" },
          },
        ]),
        "s-1",
        (paneId) => paneId === "p1",
      )?.reads,
    ).toBe("stopped");
  });
});

describe("paneCanPark", () => {
  it("parks a pane still rising by the sweep's own reasons", () => {
    expect(
      paneCanPark({ id: "p1", idle: { reason: "waking", origin: "restore" } }),
    ).toBe(true);
  });

  it("never parks one a user just asked for", () => {
    expect(
      paneCanPark({ id: "p1", idle: { reason: "waking", origin: "manual" } }),
    ).toBe(false);
  });

  it("never parks a running pane — a preference must not stop a live agent", () => {
    expect(paneCanPark({ id: "p1" })).toBe(false);
  });

  it("never re-parks one that is already down", () => {
    expect(paneCanPark({ id: "p1", idle: { reason: "parked" } })).toBe(false);
    expect(
      paneCanPark({ id: "p1", idle: { reason: "suspended", at: "t" } }),
    ).toBe(false);
  });

  it("says no for a pane that is not there", () => {
    expect(paneCanPark(undefined)).toBe(false);
  });
});
