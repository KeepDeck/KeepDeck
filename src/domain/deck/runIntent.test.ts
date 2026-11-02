import { describe, expect, it } from "vitest";
import { agentReach, paneRunIntent, type PaneProcess, type PaneRunEnv } from "./runIntent";
import type { Pane } from "./panes";

const pane = (over: Partial<Pane> = {}): Pane => ({
  id: "pane-1",
  agentType: "claude",
  ...over,
});

/** The unremarkable case: the agent exists, the directory is there, the
 *  workspace is on screen. Every test overrides only what it is about. */
const env = (over: Partial<PaneRunEnv> = {}): PaneRunEnv => ({
  agentAvailable: true,
  missingDir: null,
  workspaceActive: true,
  parkOnLaunch: false,
  startOwed: false,
  ...over,
});

const waking = { reason: "waking", origin: "restore" } as const;

/** A workspace whose one team is still creating its directory, and that
 * team's member. */
const creating = {
  teams: [
    {
      id: "team-1",
      name: "making",
      location: {
        kind: "provisioning" as const,
        intent: { repo: "/repo", path: "/wt/a", index: 1 },
      },
    },
  ],
};
const member = { team: { teamId: "team-1", role: "lead" } };

describe("paneRunIntent — a process belongs here", () => {
  it("runs a pane with no marker: the deck's record says it is up", () => {
    expect(paneRunIntent({},pane(), env())).toEqual({ kind: "run", resume: null });
  });

  it("resumes the recorded session, carrying WHO asked", () => {
    expect(
      paneRunIntent({},
        pane({ idle: waking, session: { id: "s-1", boundAt: "2026-07-26" } }),
        env(),
      ),
    ).toEqual({
      kind: "run",
      resume: { sessionId: "s-1", origin: "restore" },
    });
  });

  it("starts fresh when nothing is bound — never guesses by directory", () => {
    expect(paneRunIntent({},pane({ idle: waking }), env())).toEqual({
      kind: "run",
      resume: null,
    });
  });

  it("never resumes a remote pane locally, even with a binding clinging to it", () => {
    expect(
      paneRunIntent({},
        pane({
          idle: waking,
          location: { kind: "remote", endpoint: "wss://vps" },
          session: { id: "s-1", boundAt: "2026-07-26" },
        }),
        env(),
      ),
    ).toEqual({ kind: "run", resume: null });
  });
});

describe("paneRunIntent — reasons to stay down", () => {
  it("holds a member of a team still creating its directory: nowhere to run in yet", () => {
    expect(paneRunIntent(creating, pane(member), env())).toEqual({
      kind: "hold",
      reason: { kind: "provisioning", failed: false },
    });
  });

  it("says when that create FAILED and waits for Retry, rather than still running", () => {
    const failed = { teams: [{ ...creating.teams[0], location: { ...creating.teams[0].location, error: "git said no" } }] };
    expect(paneRunIntent(failed, pane(member), env())).toEqual({
      kind: "hold",
      reason: { kind: "provisioning", failed: true },
    });
  });

  it("holds when no plugin provides the agent, naming it", () => {
    expect(
      paneRunIntent({},pane({ idle: waking }), env({ agentAvailable: false })),
    ).toEqual({
      kind: "hold",
      reason: { kind: "agent-unavailable", agent: "claude" },
    });
  });

  it("carries a suspend marker WHOLE, so a failed wake can restore it", () => {
    const idle = { reason: "suspended", at: "2026-07-26T10:00:00.000Z" } as const;
    expect(paneRunIntent({},pane({ idle }), env())).toEqual({
      kind: "hold",
      reason: { kind: "stopped", by: idle },
    });
  });

  it("holds a parked pane the same way, by its own marker", () => {
    expect(paneRunIntent({},pane({ idle: { reason: "parked" } }), env())).toEqual({
      kind: "hold",
      reason: { kind: "stopped", by: { reason: "parked" } },
    });
  });

  it("holds a rising pane whose directory is gone, naming the directory", () => {
    expect(
      paneRunIntent({},pane({ idle: waking }), env({ missingDir: "/gone" })),
    ).toEqual({
      kind: "hold",
      reason: { kind: "worktree-missing", dir: "/gone" },
    });
  });
});

describe("paneRunIntent — lazy revive", () => {
  it("holds a restored pane whose workspace nobody has opened", () => {
    expect(
      paneRunIntent({},pane({ idle: waking }), env({ workspaceActive: false })),
    ).toEqual({ kind: "hold", reason: { kind: "workspace-inactive" } });
  });

  it("holds an UNMARKED pane off screen — economy applies to every pane, not just restored ones", () => {
    // A pane minted moments before the user switched away carries no marker,
    // and is as unopened as any other. Gating on the restore marker left it
    // free to start an agent in a workspace nobody is looking at.
    expect(paneRunIntent({},pane(), env({ workspaceActive: false }))).toEqual({
      kind: "hold",
      reason: { kind: "workspace-inactive" },
    });
  });

  it("keeps running a pane owed a start AFTER its marker is cleared", () => {
    // The wake succeeds one pass before the process is acquired, and the
    // marker that carried the exemption is cleared in between. Reading the
    // exemption off the marker alone stranded the pane in that gap: no
    // durable stamp, no process, and a command that reported success.
    expect(
      paneRunIntent({},pane(), env({ workspaceActive: false, startOwed: true })),
    ).toEqual({ kind: "run", resume: null });
  });

  it("runs a pane owed a start that is still WAKING off screen", () => {
    // A restart, or the boot-resume recovery, retires the process and owes
    // one back. Neither sets a `manual` origin, so this rung — not the one
    // above — is what a resume reaching an off-screen pane depends on.
    expect(
      paneRunIntent({},
        pane({ idle: { reason: "waking", origin: "restore" } }),
        env({ workspaceActive: false, startOwed: true }),
      ),
    ).toEqual({ kind: "run", resume: null });
  });

  it("runs a pane asked for BY NAME off screen — the request must reach it", () => {
    expect(
      paneRunIntent({},
        pane({ idle: { reason: "waking", origin: "manual" } }),
        env({ workspaceActive: false }),
      ),
    ).toEqual({ kind: "run", resume: null });
  });

  it("still refuses a manual wake whose directory is gone", () => {
    expect(
      paneRunIntent({},
        pane({ idle: { reason: "waking", origin: "manual" } }),
        env({ workspaceActive: false, missingDir: "/gone" }),
      ),
    ).toEqual({
      kind: "hold",
      reason: { kind: "worktree-missing", dir: "/gone" },
    });
  });
});

describe("paneRunIntent — the launch policy", () => {
  it("parks a restored pane that has not started yet", () => {
    expect(
      paneRunIntent({},pane({ idle: waking }), env({ parkOnLaunch: true })),
    ).toEqual({
      kind: "hold",
      reason: { kind: "stopped", by: { reason: "parked" } },
    });
  });

  it("parks one waiting in a background workspace too — that is the point", () => {
    // The population the setting names is "restored agents that have not
    // started", and a pane in an unopened workspace has been exactly that
    // since the app booted, however long ago the policy was turned on.
    expect(
      paneRunIntent({},
        pane({ idle: waking }),
        env({ parkOnLaunch: true, workspaceActive: false }),
      ),
    ).toEqual({
      kind: "hold",
      reason: { kind: "stopped", by: { reason: "parked" } },
    });
  });

  it("does NOT hold a wake the user asked for by name", () => {
    expect(
      paneRunIntent({},
        pane({ idle: { reason: "waking", origin: "manual" } }),
        env({ parkOnLaunch: true }),
      ),
    ).toEqual({ kind: "run", resume: null });
  });

  it("leaves a RUNNING pane alone — a preference must not kill a live agent", () => {
    expect(paneRunIntent({},pane(), env({ parkOnLaunch: true }))).toEqual({
      kind: "run",
      resume: null,
    });
  });

  it("outranks a gone directory: a pane that is not starting is not relocating", () => {
    expect(
      paneRunIntent({},
        pane({ idle: waking }),
        env({ parkOnLaunch: true, missingDir: "/gone" }),
      ),
    ).toEqual({
      kind: "hold",
      reason: { kind: "stopped", by: { reason: "parked" } },
    });
  });

  it("keeps a suspend stamp rather than overwriting it with the policy's", () => {
    const idle = { reason: "suspended", at: "2026-07-26T10:00:00.000Z" } as const;
    expect(paneRunIntent({},pane({ idle }), env({ parkOnLaunch: true }))).toEqual({
      kind: "hold",
      reason: { kind: "stopped", by: idle },
    });
  });
});

describe("paneRunIntent — precedence", () => {
  it("provisioning outranks everything: nothing else can be acted on", () => {
    expect(
      paneRunIntent(
        creating,
        pane({ ...member, idle: { reason: "suspended", at: "2026-07-26T10:00:00.000Z" } }),
        env({ agentAvailable: false, missingDir: "/gone" }),
      ),
    ).toEqual({ kind: "hold", reason: { kind: "provisioning", failed: false } });
  });

  it("an absent agent outranks a stopped marker, matching the card ladder", () => {
    expect(
      paneRunIntent({},
        pane({ idle: { reason: "suspended", at: "2026-07-26T10:00:00.000Z" } }),
        env({ agentAvailable: false }),
      ),
    ).toEqual({
      kind: "hold",
      reason: { kind: "agent-unavailable", agent: "claude" },
    });
  });

  it("a stopped pane is not asked whether its directory is still there", () => {
    expect(
      paneRunIntent({},
        pane({ idle: { reason: "parked" } }),
        env({ missingDir: "/gone" }),
      ),
    ).toEqual({
      kind: "hold",
      reason: { kind: "stopped", by: { reason: "parked" } },
    });
  });
});

describe("agentReach — would its agent read something sent now", () => {
  const run = paneRunIntent({}, pane(), env());
  const reach = (process: PaneProcess, planFailed = false) => agentReach(run, process, planFailed);

  it("reads a live process as running, and one coming up as starting", () => {
    expect(reach("live")).toEqual({ kind: "running" });
    expect(reach("starting")).toEqual({ kind: "starting" });
    // No process yet and nothing failed: its plan is on the way.
    expect(reach("none")).toEqual({ kind: "starting" });
  });

  it("reads an agent that ended or never came up as down", () => {
    expect(reach("exited")).toEqual({ kind: "down", why: "exited" });
    expect(reach("failed")).toEqual({ kind: "down", why: "failed-to-start" });
    expect(reach("none", true)).toEqual({ kind: "down", why: "failed-to-start" });
  });

  it("reads a pane held by a decision or a fault as down, whatever its process says", () => {
    // A suspended team's member: the case that started this (task-557).
    const suspended = paneRunIntent({}, pane({ idle: { reason: "suspended", at: "2026-11-02" } }), env());
    const parked = paneRunIntent({}, pane({ idle: { reason: "parked" } }), env());
    const unavailable = paneRunIntent({}, pane(), env({ agentAvailable: false }));
    const gone = paneRunIntent({}, pane({ idle: waking }), env({ missingDir: "/gone" }));
    for (const process of ["none", "live"] as PaneProcess[]) {
      expect(agentReach(suspended, process, false), process).toEqual({ kind: "down", why: "suspended" });
      expect(agentReach(parked, process, false), process).toEqual({ kind: "down", why: "parked" });
      expect(agentReach(unavailable, process, false), process).toEqual({ kind: "down", why: "agent-unavailable" });
      expect(agentReach(gone, process, false), process).toEqual({ kind: "down", why: "worktree-missing" });
    }
  });

  it("reads a member of a team still creating its directory as starting — and as down once that create failed", () => {
    const provisioning = paneRunIntent(creating, pane(member), env());
    expect(agentReach(provisioning, "none", false)).toEqual({ kind: "starting" });
    // Nothing brings it up until somebody hits Retry (reviewer-1, task-557).
    const failed = { teams: [{ ...creating.teams[0], location: { ...creating.teams[0].location, error: "git said no" } }] };
    expect(agentReach(paneRunIntent(failed, pane(member), env()), "none", false)).toEqual({
      kind: "down",
      why: "provisioning-failed",
    });
  });

  it("reads a pane off screen as down only when it has no process — one running there keeps running", () => {
    const offScreen = paneRunIntent({}, pane(), env({ workspaceActive: false }));
    expect(agentReach(offScreen, "none", false)).toEqual({ kind: "down", why: "workspace-closed" });
    expect(agentReach(offScreen, "live", false)).toEqual({ kind: "running" });
    expect(agentReach(offScreen, "exited", false)).toEqual({ kind: "down", why: "exited" });
  });
});
