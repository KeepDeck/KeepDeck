import { describe, expect, it } from "vitest";
import {
  BRIDGE_PROTOCOL,
  createWire,
  parseBridge,
} from "../resources/reporters/keepdeck-wire.js";

const BRIDGE = { dir: "/run/p-1", pane: "p-1", token: "secret", url: "http://127.0.0.1:9/envelope" };

describe("parseBridge", () => {
  it("reads the four fields a pane is armed with", () => {
    expect(parseBridge(JSON.stringify({ ...BRIDGE, v: 2 }))).toEqual(BRIDGE);
  });

  it("is absent, not half-armed, when anything is missing or unreadable", () => {
    for (const raw of [undefined, "", "not json", "null", JSON.stringify({ ...BRIDGE, url: "" })]) {
      expect(parseBridge(raw)).toBeNull();
    }
    const { url: _url, ...noUrl } = BRIDGE;
    expect(parseBridge(JSON.stringify(noUrl))).toBeNull();
  });
});

describe("createWire", () => {
  const wireWith = (post) => createWire({ bridge: BRIDGE, agent: "claude", reporter: "42", post });

  it("addresses every envelope to the pane, with who is reporting", () => {
    const wire = wireWith(async () => ({ status: 204, body: "" }));
    expect(wire.makeEnvelope("agent.status", { event: { x: 1 } })).toEqual({
      v: BRIDGE_PROTOCOL,
      type: "agent.status",
      paneId: "p-1",
      token: "secret",
      payload: { agent: "claude", reporter: "42", event: { x: 1 } },
    });
  });

  it("answers only what a 200 carried; anything else, or a failed post, is no answer", async () => {
    const sent = [];
    const answers = [
      { status: 200, body: "mail" },
      { status: 204, body: "" },
      { status: 504, body: "late" },
      { status: 0, body: "" },
    ];
    const wire = wireWith(async (url, body) => {
      sent.push([url, JSON.parse(body)]);
      return answers.shift();
    });
    const envelope = wire.makeEnvelope("agent.status", {});
    expect(await wire.send(envelope)).toEqual({ answer: "mail" });
    for (let i = 0; i < 3; i++) expect(await wire.send(envelope)).toEqual({ answer: null });
    expect(sent[0]).toEqual([BRIDGE.url, envelope]);

    const throwing = wireWith(() => {
      throw new Error("no network");
    });
    expect(await throwing.send(envelope)).toEqual({ answer: null });
    const rejecting = wireWith(async () => {
      throw new Error("refused");
    });
    expect(await rejecting.send(envelope)).toEqual({ answer: null });
  });

  it("publishes facts one after another, in the order they were stated, past a failure", async () => {
    const order = [];
    const releases = [];
    const wire = wireWith(
      (_url, body) =>
        new Promise((resolve, reject) => {
          const n = JSON.parse(body).payload.n;
          order.push(`start ${n}`);
          releases.push(() => {
            order.push(`end ${n}`);
            if (n === 1) reject(new Error("lost"));
            else resolve({ status: 204, body: "" });
          });
        }),
    );
    wire.publish(wire.makeEnvelope("agent.status", { n: 1 }));
    wire.publish(wire.makeEnvelope("agent.status", { n: 2 }));
    await Promise.resolve();
    await Promise.resolve();
    // The second has not started while the first is out.
    expect(order).toEqual(["start 1"]);
    releases[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["start 1", "end 1", "start 2"]);
    releases[1]();
    await wire.drained();
    expect(order).toEqual(["start 1", "end 1", "start 2", "end 2"]);
  });
});
