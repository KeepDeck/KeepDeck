import { describe, expect, it } from "vitest";
import { speechErrorKind } from "@keepdeck/plugin-api";
import { GuestRpc } from "./rpc";
import { instanceOf, recordOf } from "@keepdeck/plugin-api/testing";

/** A GuestRpc over a port that posts nowhere — results are settled by hand. */
function rpc(): GuestRpc {
  return new GuestRpc({ postMessage: () => {} });
}

describe("GuestRpc", () => {
  it("rejects with the host's message and code, so a realm plugin reads the same kind", async () => {
    const client = rpc();
    const call = client.call("services.speech.start", [1]).catch((e: unknown) => e);
    client.settle({ kind: "result", id: 1, ok: false, error: "a capture is already running", code: "busy" });
    const rejected = await call;
    expect(instanceOf(rejected, Error, "rejection").message).toBe("a capture is already running");
    expect(speechErrorKind(rejected)).toBe("busy");
  });

  it("rejects with no code when the host sent none", async () => {
    const client = rpc();
    const call = client.call("storage.global.get", ["k"]).catch((e: unknown) => e);
    client.settle({ kind: "result", id: 1, ok: false, error: "boom" });
    expect("code" in recordOf(await call, "call error")).toBe(false);
  });
});
