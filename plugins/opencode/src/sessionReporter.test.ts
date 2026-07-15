import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// The reporter is untyped resource JS — it is shipped to, and loaded by, the
// user's opencode process, never bundled into the plugin.
// @ts-expect-error untyped resource module
import reporter from "../resources/session-reporter.js";

/** An opencode `session.created` event; `parentID` marks a CHILD session. */
const created = (id: string, parentID?: string) => ({
  event: { type: "session.created", properties: { info: { id, parentID } } },
});

describe("opencode session reporter", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kd-reporter-"));
    process.env.KEEPDECK_BRIDGE = JSON.stringify({
      v: 1,
      dir,
      pane: "pane-3",
      token: "tok",
    });
  });

  afterEach(() => {
    delete process.env.KEEPDECK_BRIDGE;
    rmSync(dir, { recursive: true, force: true });
  });

  /** The envelopes the reporter dropped in the bridge inbox. */
  const envelopes = () =>
    readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));

  it("binds the pane to a root session", async () => {
    const { event } = await reporter();
    await event(created("ses_root"));

    expect(envelopes()).toEqual([
      {
        v: 1,
        type: "session.bound",
        paneId: "pane-3",
        token: "tok",
        payload: { sessionId: "ses_root", agent: "opencode" },
      },
    ]);
  });

  it("ignores a child session so the pane never rebinds to a leaf", async () => {
    const { event } = await reporter();
    await event(created("ses_child", "ses_root"));

    expect(envelopes()).toEqual([]);
  });

  it("ignores events that are not a session creation", async () => {
    const { event } = await reporter();
    await event({ event: { type: "session.updated", properties: { info: { id: "ses_x" } } } });

    expect(envelopes()).toEqual([]);
  });

  it("stays inert outside KeepDeck", async () => {
    delete process.env.KEEPDECK_BRIDGE;
    expect(await reporter()).toEqual({});
  });

  it("stays inert when the bridge envelope is incomplete", async () => {
    process.env.KEEPDECK_BRIDGE = JSON.stringify({ v: 1, dir });
    expect(await reporter()).toEqual({});
  });
});
