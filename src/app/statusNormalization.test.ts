import { expect, it, vi } from "vitest";
import { isJsonRecord, type StatusNormalizer } from "@keepdeck/plugin-api";
import { normalizeStatusBatch } from "./statusNormalization";
import { createAgentStatusTracker } from "./agentStatusTracker";

const decoder: StatusNormalizer = (payload, at, context) => {
  const count = typeof context?.state === "number" ? context.state : 0;
  if (!isJsonRecord(payload)) return null;
  if (payload.event === "metadata") return { kind: "status-reduction", state: count + 1, events: [] };
  return { kind: "status-reduction", state: count, events: [{ kind: "turn-start", at: at + count }] };
};

it("decodes ordered records without changing its input checkpoint", () => {
  expect(normalizeStatusBatch(decoder, [{ event: "metadata" }, { event: "metadata" }, {}], 100, 0))
    .toEqual({ state: 2, events: [{ kind: "turn-start", at: 102 }] });
});

it("context-only replay can never publish activity", () => {
  expect(normalizeStatusBatch(decoder, [{ event: "metadata" }, {}], 100, undefined, undefined, true))
    .toEqual({ state: 1, events: [] });
});

it("keeps decoding state per pane and commits no state during preview", () => {
  const tracker = createAgentStatusTracker();
  tracker.registerNormalizer("test", decoder);
  const metadata = { agent: "test", event: "metadata" };
  const first = tracker.prepare("one", metadata, 100);
  tracker.report("one", metadata, 100);
  first.finish(); // Must rebase on the committed state, not overwrite it.
  tracker.report("one", { agent: "test" }, 200);
  tracker.report("two", { agent: "test" }, 200);
  expect(tracker.getSnapshot().panes.get("one")).toEqual({ state: "working", since: 202 });
  expect(tracker.getSnapshot().panes.get("two")).toEqual({ state: "working", since: 200 });
});

it.each(["clear", "retain", "replace"])("retires unpublished decoder state on %s", (how) => {
  const tracker = createAgentStatusTracker();
  tracker.registerNormalizer("test", decoder);
  tracker.report("one", { agent: "test", event: "metadata" }, 100);
  expect(tracker.getSnapshot().panes.size).toBe(0);
  if (how === "clear") tracker.clear("one");
  if (how === "retain") tracker.retain(new Set());
  if (how === "replace") tracker.registerNormalizer("test", (...args) => decoder(...args));
  tracker.report("one", { agent: "test" }, 200);
  expect(tracker.getSnapshot().panes.get("one")).toEqual({ state: "working", since: 200 });
});

it("metadata reports neither notify nor invent a pane, but seed its next live decode", () => {
  const tracker = createAgentStatusTracker();
  tracker.registerNormalizer("test", decoder);
  const changed = vi.fn();
  tracker.subscribe(changed);
  tracker.report("one", { agent: "test", event: "metadata", contextOnly: true }, 100);
  expect(changed).not.toHaveBeenCalled();
  expect(tracker.getSnapshot().panes.size).toBe(0);
  tracker.report("one", { agent: "test" }, 200);
  expect(tracker.getSnapshot().panes.get("one")).toEqual({ state: "working", since: 201 });
});
