import { describe, expect, it } from "vitest";
import {
  attachedWorktree,
  locationOf,
  paneBranch,
  placementFromFields,
  placementToFields,
  provisioningCard,
} from "./location";
import type { PaneLocation, WorktreeIntent } from "./model";

const intent: WorktreeIntent = {
  repo: "/repo",
  path: "/repo/wt",
  index: 1,
};

describe("locationOf", () => {
  it("reads an absent location as the workspace cwd", () => {
    expect(locationOf({})).toEqual({ kind: "main" });
  });

  it("returns the location the pane holds", () => {
    const location: PaneLocation = { kind: "attached", cwd: "/repo/wt" };
    expect(locationOf({ location })).toBe(location);
  });
});

describe("placementFromFields", () => {
  describe("the four shapes", () => {
    it("reads no fields as running in the workspace cwd", () => {
      expect(placementFromFields({})).toEqual({ kind: "main" });
    });

    it("reads a directory as attached, carrying the branch when there is one", () => {
      expect(placementFromFields({ cwd: "/repo/wt", branch: "kd/ws/1" })).toEqual({
        kind: "attached",
        cwd: "/repo/wt",
        branch: "kd/ws/1",
      });
    });

    it("reads a directory without a branch as attached with no branch key", () => {
      const location = placementFromFields({ cwd: "/repo/wt" });
      expect(location).toEqual({ kind: "attached", cwd: "/repo/wt" });
      // Not `branch: undefined` — the shape must round-trip through a sparse
      // serializer without minting a key.
      expect(Object.keys(location)).toEqual(["kind", "cwd"]);
    });

    it("reads an intent with no directory as provisioning, intent whole and no status", () => {
      // A document holds the intent alone; whatever status the card had
      // before the restart is not in it, and hydration stamps its own.
      expect(placementFromFields({ provisioning: intent })).toEqual({
        kind: "provisioning",
        intent,
      });
    });

    it("reads an endpoint as remote", () => {
      expect(placementFromFields({ remoteEndpoint: "wss://vps" })).toEqual({
        kind: "remote",
        endpoint: "wss://vps",
      });
    });

    it("keeps a recorded branch on a bare pane — a session resumed from the root", () => {
      expect(placementFromFields({ branch: "kd/ws/1" })).toEqual({
        kind: "main",
        branch: "kd/ws/1",
      });
    });
  });

  describe("combinations the fields allow and the meaning does not", () => {
    it("lets the endpoint win over a directory — the local location is moot", () => {
      expect(
        placementFromFields({ remoteEndpoint: "wss://vps", cwd: "/repo/wt", branch: "b" }),
      ).toEqual({ kind: "remote", endpoint: "wss://vps" });
    });

    it("lets the endpoint win over a card", () => {
      expect(placementFromFields({ remoteEndpoint: "wss://vps", provisioning: intent })).toEqual(
        { kind: "remote", endpoint: "wss://vps" },
      );
    });

    it("reads a directory beside a card as attached — the create landed", () => {
      expect(placementFromFields({ cwd: "/repo/wt", provisioning: intent })).toEqual({
        kind: "attached",
        cwd: "/repo/wt",
      });
    });

    it("treats an empty endpoint as not remote, like the predicate it replaced", () => {
      expect(placementFromFields({ remoteEndpoint: "" })).toEqual({ kind: "main" });
      expect(placementFromFields({ remoteEndpoint: "", cwd: "/repo/wt" })).toEqual({
        kind: "attached",
        cwd: "/repo/wt",
      });
    });
  });
});

describe("placementToFields", () => {
  const locations: PaneLocation[] = [
    { kind: "main" },
    { kind: "main", branch: "kd/ws/1" },
    { kind: "attached", cwd: "/repo/wt" },
    { kind: "attached", cwd: "/repo/wt", branch: "kd/ws/2" },
    { kind: "provisioning", intent },
    { kind: "remote", endpoint: "wss://vps" },
  ];

  it.each(locations)("round-trips %j through the four fields", (location) => {
    expect(placementFromFields(placementToFields(location))).toEqual(location);
  });

  it("writes only the fields the location holds", () => {
    expect(Object.keys(placementToFields({ kind: "main" }))).toEqual([]);
    expect(Object.keys(placementToFields({ kind: "attached", cwd: "/x" }))).toEqual(["cwd"]);
    expect(Object.keys(placementToFields({ kind: "remote", endpoint: "e" }))).toEqual([
      "remoteEndpoint",
    ]);
  });

  it("keeps a card's status back — the error and the fork marker are this run's", () => {
    expect(
      placementToFields({ kind: "provisioning", intent, error: "boom", fork: true }),
    ).toEqual({ provisioning: intent });
  });
});

describe("projections", () => {
  it("projects the worktree of an attached pane and nothing for the rest", () => {
    expect(
      attachedWorktree({ location: { kind: "attached", cwd: "/repo/wt", branch: "b" } }),
    ).toMatchObject({ cwd: "/repo/wt", branch: "b" });
    expect(attachedWorktree({})).toBeNull();
    expect(attachedWorktree({ location: { kind: "main", branch: "b" } })).toBeNull();
    expect(attachedWorktree({ location: { kind: "provisioning", intent } })).toBeNull();
    expect(attachedWorktree({ location: { kind: "remote", endpoint: "e" } })).toBeNull();
  });

  it("projects the card of a provisioning pane and nothing for the rest", () => {
    const card = { kind: "provisioning" as const, intent, error: "boom" };
    expect(provisioningCard({ location: card })).toBe(card);
    expect(provisioningCard({})).toBeNull();
    expect(provisioningCard({ location: { kind: "attached", cwd: "/repo/wt" } })).toBeNull();
  });

  it("names the branch for a bare or attached pane and nothing otherwise", () => {
    expect(paneBranch({ location: { kind: "main", branch: "kd/ws/1" } })).toBe("kd/ws/1");
    expect(paneBranch({ location: { kind: "attached", cwd: "/x", branch: "kd/ws/2" } })).toBe(
      "kd/ws/2",
    );
    expect(paneBranch({ location: { kind: "attached", cwd: "/x" } })).toBeUndefined();
    expect(paneBranch({})).toBeUndefined();
    expect(
      paneBranch({ location: { kind: "provisioning", intent: { ...intent, branch: "planned" } } }),
    ).toBeUndefined();
    expect(paneBranch({ location: { kind: "remote", endpoint: "e" } })).toBeUndefined();
  });
});

describe("the type", () => {
  it("holds one placement — a directory and a card cannot share a location", () => {
    // The state the four fields used to allow. Checked by the compiler:
    // typecheck fails on an unused expectation the day the union lets it in.
    // @ts-expect-error — an attached location has no create intent
    const landed: PaneLocation = { kind: "attached", cwd: "/repo/wt", intent };
    // @ts-expect-error — a create in flight has no directory beside it
    const pending: PaneLocation = { kind: "provisioning", intent, cwd: "/repo/wt" };
    expect([landed, pending]).toHaveLength(2);
  });
});
