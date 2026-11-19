import { describe, expect, it, vi } from "vitest";
import { sdkSection } from "./resourceTestSupport.test-support";
// Resource JS — shipped to, and loaded by, the user's opencode.
import { promptSelection, type SessionInfo } from "../resources/keepdeck-plugin/prompt-selection.js";

/** A client answering `session.get` with `info` as the session, the way the
 * 1.19.3 server answers `GET /session/:id`. */
const clientOver = (info: SessionInfo) => {
  const get = vi.fn(async (call: { path: { id: string } }) => ({ data: { id: call.path.id, ...info } }));
  return { client: { session: sdkSection({ get }) }, get };
};

describe("the selection a delivery repeats", () => {
  it("is the session's own: agent, model and variant", async () => {
    const { client, get } = clientOver({
      agent: "custom",
      model: { id: "alt", providerID: "probe", variant: "max" },
    });
    expect(await promptSelection(client, "ses_1")).toEqual({
      agent: "custom",
      model: { providerID: "probe", modelID: "alt" },
      variant: "max",
    });
    expect(get).toHaveBeenCalledWith({ path: { id: "ses_1" } });
  });

  it("sends no variant for the one opencode stores as \"default\"", async () => {
    // The server writes `variant ?? "default"` into the session; the TUI
    // never sends "default" as a variant, and neither does a delivery.
    const { client } = clientOver({ agent: "build", model: { id: "alt", providerID: "probe", variant: "default" } });
    expect(await promptSelection(client, "s")).toEqual({
      agent: "build",
      model: { providerID: "probe", modelID: "alt" },
    });
  });

  it("leaves out what the session does not say", async () => {
    const { client } = clientOver({ agent: "", model: { id: "alt", providerID: "probe" } });
    expect(await promptSelection(client, "s")).toEqual({ model: { providerID: "probe", modelID: "alt" } });
  });

  it("keeps the agent of a session made with no model yet", async () => {
    // Without it opencode runs the delivery as the config's default agent.
    expect(await promptSelection(clientOver({ agent: "custom" }).client, "s")).toEqual({ agent: "custom" });
    expect(
      await promptSelection(clientOver({ agent: "custom", model: { providerID: "probe", variant: "max" } }).client, "s"),
    ).toEqual({ agent: "custom" });
  });

  it("is nothing — a bare delivery — when the session holds no selection, or cannot be read", async () => {
    expect(await promptSelection(clientOver({ model: { providerID: "probe" } }).client, "s")).toEqual({});
    const failing = { session: sdkSection({ get: async () => ({ error: { name: "NotFoundError" } }) }) };
    expect(await promptSelection(failing, "s")).toEqual({});
    const throwing = { session: sdkSection({ get: async () => { throw new Error("gone"); } }) };
    expect(await promptSelection(throwing, "s")).toEqual({});
    expect(await promptSelection({}, "s")).toEqual({});
  });
});
