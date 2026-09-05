import { describe, expect, it } from "vitest";
import { locationOf } from "./location";
import type { PaneProvisioning } from "./model";

const card: PaneProvisioning = {
  repo: "/repo",
  path: "/repo/wt",
  workspace: "ws",
  index: 1,
};

describe("locationOf", () => {
  describe("the four shapes", () => {
    it("reads a bare pane as running in the workspace cwd", () => {
      expect(locationOf({})).toEqual({ kind: "main" });
    });

    it("reads a directory as attached, carrying the branch when there is one", () => {
      expect(locationOf({ cwd: "/repo/wt", branch: "kd/ws/1" })).toEqual({
        kind: "attached",
        cwd: "/repo/wt",
        branch: "kd/ws/1",
      });
    });

    it("reads a directory without a branch as attached with no branch key", () => {
      const location = locationOf({ cwd: "/repo/wt" });
      expect(location).toEqual({ kind: "attached", cwd: "/repo/wt" });
      // Not `branch: undefined` — the shape must round-trip through a sparse
      // serializer without minting a key.
      expect(Object.keys(location)).toEqual(["kind", "cwd"]);
    });

    it("reads a card with no directory as provisioning, card whole", () => {
      const failed = { ...card, error: "boom", fork: true as const };
      expect(locationOf({ provisioning: failed })).toEqual({
        kind: "provisioning",
        card: failed,
      });
    });

    it("reads an endpoint as remote", () => {
      expect(locationOf({ remoteEndpoint: "wss://vps" })).toEqual({
        kind: "remote",
        endpoint: "wss://vps",
      });
    });
  });

  describe("combinations the fields allow and the meaning does not", () => {
    it("lets the endpoint win over a directory — the local location is moot", () => {
      expect(
        locationOf({ remoteEndpoint: "wss://vps", cwd: "/repo/wt", branch: "b" }),
      ).toEqual({ kind: "remote", endpoint: "wss://vps" });
    });

    it("lets the endpoint win over a card", () => {
      expect(locationOf({ remoteEndpoint: "wss://vps", provisioning: card })).toEqual({
        kind: "remote",
        endpoint: "wss://vps",
      });
    });

    it("reads a directory beside a card as attached — the create landed", () => {
      expect(locationOf({ cwd: "/repo/wt", provisioning: card })).toEqual({
        kind: "attached",
        cwd: "/repo/wt",
      });
    });

    it("ignores a branch with no directory beside it", () => {
      expect(locationOf({ branch: "kd/ws/1" })).toEqual({ kind: "main" });
    });

    it("treats an empty endpoint as not remote, like the predicate it replaces", () => {
      expect(locationOf({ remoteEndpoint: "" })).toEqual({ kind: "main" });
      expect(locationOf({ remoteEndpoint: "", cwd: "/repo/wt" })).toEqual({
        kind: "attached",
        cwd: "/repo/wt",
      });
    });
  });
});
