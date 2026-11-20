import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The lifecycle commands' wire contract with src-tauri/src/lifecycle/
 * commands.rs: each door is one command, its arguments under the keys Tauri
 * maps the Rust parameter names to.
 */
const tauri = vi.hoisted(() => {
  const channels: { onmessage: ((message: unknown) => void) | null }[] = [];
  return {
    invoke: vi.fn(async (_command: string, _args?: object): Promise<unknown> => undefined),
    channels,
    channel: class {
      onmessage: ((message: unknown) => void) | null = null;
      constructor() {
        channels.push(this);
      }
    },
  };
});
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke, Channel: tauri.channel }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { versioned } from "./generated/lifecycle/examples";
import type { Heard } from "./generated/lifecycle/Heard";
import * as lifecycle from "./lifecycle";

describe("the lifecycle's doors", () => {
  beforeEach(() => tauri.invoke.mockClear());

  it("send each call as its one command, under the Rust parameter names", async () => {
    const intent = { kind: "archive", workspace: "ws-a" } as const;
    const id = { op: 3, index: 1 };
    await lifecycle.sendIntent(intent);
    await lifecycle.askLease({ kind: "arm", workspace: "ws-a", dir: "/wt/a" });
    await lifecycle.releaseLease(2);
    await lifecycle.reportApplied(id, { kind: "applied", revision: 4 });
    await lifecycle.reportHookEnded(3);
    await lifecycle.reportDeckSaved(4);
    await lifecycle.previewIntent(intent);
    await lifecycle.claimsOn("/wt/a");
    await lifecycle.locationFor("ws-a", null);
    await lifecycle.bootHandshake({ workspaces: [] }, "loaded");
    expect(tauri.invoke.mock.calls).toEqual([
      ["lifecycle_intent", { intent }],
      ["lifecycle_lease", { lease: { kind: "arm", workspace: "ws-a", dir: "/wt/a" } }],
      ["lifecycle_release", { permit: 2 }],
      ["lifecycle_applied", { id, outcome: { kind: "applied", revision: 4 } }],
      ["lifecycle_hook_ended", { op: 3 }],
      ["lifecycle_deck_saved", { revision: 4 }],
      ["lifecycle_preview", { intent }],
      ["lifecycle_claims", { path: "/wt/a" }],
      ["lifecycle_location", { workspace: "ws-a", candidate: null }],
      ["lifecycle_boot_handshake", { deck: { workspaces: [] }, load: "loaded" }],
    ]);
  });

  it("hand everything heard on the one channel on as it came", async () => {
    const heard: Heard[] = [];
    await lifecycle.subscribeLifecycle((message) => heard.push(message));
    const channel = tauri.channels[tauri.channels.length - 1];
    expect(tauri.invoke).toHaveBeenCalledWith("lifecycle_subscribe", { onHeard: channel });
    channel?.onmessage?.({ kind: "snapshot", versioned });
    channel?.onmessage?.({ kind: "stopped" });
    expect(heard).toEqual([{ kind: "snapshot", versioned }, { kind: "stopped" }]);
  });
});
