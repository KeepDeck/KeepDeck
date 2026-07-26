import { describe, expect, it } from "vitest";
import { paneRunIntent, type PaneRunEnv } from "./runIntent";
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
  ...over,
});

const waking = { reason: "waking", origin: "restore" } as const;

describe("paneRunIntent — a process belongs here", () => {
  it("runs a pane with no marker: the deck's record says it is up", () => {
    expect(paneRunIntent(pane(), env())).toEqual({ kind: "run", resume: null });
  });

  it("resumes the recorded session, carrying WHO asked", () => {
    expect(
      paneRunIntent(
        pane({ idle: waking, session: { id: "s-1", boundAt: "2026-07-26" } }),
        env(),
      ),
    ).toEqual({
      kind: "run",
      resume: { sessionId: "s-1", origin: "restore" },
    });
  });

  it("starts fresh when nothing is bound — never guesses by directory", () => {
    expect(paneRunIntent(pane({ idle: waking }), env())).toEqual({
      kind: "run",
      resume: null,
    });
  });

  it("never resumes a remote pane locally, even with a binding clinging to it", () => {
    expect(
      paneRunIntent(
        pane({
          idle: waking,
          remoteEndpoint: "wss://vps",
          session: { id: "s-1", boundAt: "2026-07-26" },
        }),
        env(),
      ),
    ).toEqual({ kind: "run", resume: null });
  });
});

describe("paneRunIntent — reasons to stay down", () => {
  it("holds a provisioning pane: it has no directory to run in yet", () => {
    expect(
      paneRunIntent(
        pane({
          provisioning: { repo: "/repo", workspace: "ws", index: 1 },
        }),
        env(),
      ),
    ).toEqual({ kind: "hold", reason: { kind: "provisioning" } });
  });

  it("holds when no plugin provides the agent, naming it", () => {
    expect(
      paneRunIntent(pane({ idle: waking }), env({ agentAvailable: false })),
    ).toEqual({
      kind: "hold",
      reason: { kind: "agent-unavailable", agent: "claude" },
    });
  });

  it("defaults the agent id the way the persisted format does", () => {
    const intent = paneRunIntent(
      pane({ agentType: undefined }),
      env({ agentAvailable: false }),
    );
    expect(intent).toEqual({
      kind: "hold",
      reason: { kind: "agent-unavailable", agent: "claude" },
    });
  });

  it("carries a suspend marker WHOLE, so a failed wake can restore it", () => {
    const idle = { reason: "suspended", at: "2026-07-26T10:00:00.000Z" } as const;
    expect(paneRunIntent(pane({ idle }), env())).toEqual({
      kind: "hold",
      reason: { kind: "stopped", by: idle },
    });
  });

  it("holds a parked pane the same way, by its own marker", () => {
    expect(paneRunIntent(pane({ idle: { reason: "parked" } }), env())).toEqual({
      kind: "hold",
      reason: { kind: "stopped", by: { reason: "parked" } },
    });
  });

  it("holds a rising pane whose directory is gone, naming the directory", () => {
    expect(
      paneRunIntent(pane({ idle: waking }), env({ missingDir: "/gone" })),
    ).toEqual({
      kind: "hold",
      reason: { kind: "worktree-missing", dir: "/gone" },
    });
  });
});

describe("paneRunIntent — lazy revive", () => {
  it("holds a restored pane whose workspace nobody has opened", () => {
    expect(
      paneRunIntent(pane({ idle: waking }), env({ workspaceActive: false })),
    ).toEqual({ kind: "hold", reason: { kind: "workspace-inactive" } });
  });

  it("runs a pane asked for BY NAME off screen — the request must reach it", () => {
    expect(
      paneRunIntent(
        pane({ idle: { reason: "waking", origin: "manual" } }),
        env({ workspaceActive: false }),
      ),
    ).toEqual({ kind: "run", resume: null });
  });

  it("still refuses a manual wake whose directory is gone", () => {
    expect(
      paneRunIntent(
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
      paneRunIntent(pane({ idle: waking }), env({ parkOnLaunch: true })),
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
      paneRunIntent(
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
      paneRunIntent(
        pane({ idle: { reason: "waking", origin: "manual" } }),
        env({ parkOnLaunch: true }),
      ),
    ).toEqual({ kind: "run", resume: null });
  });

  it("leaves a RUNNING pane alone — a preference must not kill a live agent", () => {
    expect(paneRunIntent(pane(), env({ parkOnLaunch: true }))).toEqual({
      kind: "run",
      resume: null,
    });
  });

  it("outranks a gone directory: a pane that is not starting is not relocating", () => {
    expect(
      paneRunIntent(
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
    expect(paneRunIntent(pane({ idle }), env({ parkOnLaunch: true }))).toEqual({
      kind: "hold",
      reason: { kind: "stopped", by: idle },
    });
  });
});

describe("paneRunIntent — precedence", () => {
  it("provisioning outranks everything: nothing else can be acted on", () => {
    expect(
      paneRunIntent(
        pane({
          idle: { reason: "suspended", at: "2026-07-26T10:00:00.000Z" },
          provisioning: { repo: "/repo", workspace: "ws", index: 1 },
        }),
        env({ agentAvailable: false, missingDir: "/gone" }),
      ),
    ).toEqual({ kind: "hold", reason: { kind: "provisioning" } });
  });

  it("an absent agent outranks a stopped marker, matching the card ladder", () => {
    expect(
      paneRunIntent(
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
      paneRunIntent(
        pane({ idle: { reason: "parked" } }),
        env({ missingDir: "/gone" }),
      ),
    ).toEqual({
      kind: "hold",
      reason: { kind: "stopped", by: { reason: "parked" } },
    });
  });
});
