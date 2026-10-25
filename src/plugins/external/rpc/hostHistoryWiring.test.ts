import { describe, expect, it } from "vitest";
import { agentEntry, dispatchHarness } from "./hostDispatch.testSupport";
import type { WireAgentHistoryCall } from "./protocol";
import { present } from "@keepdeck/plugin-api/testing";

/**
 * The WIRING of the negotiated history methods — not their shapes.
 *
 * The shapes have their own unit tests, and those pass whether or not the
 * proxy that feeds them was ever built. This file exists because a negotiated
 * method has a fallback that is IDENTICAL by construction: delete the proxy
 * and the caller quietly gets the legacy answer, which for the same session
 * is the same answer. Every witness that compares results is therefore dead
 * before it is written — the only thing that separates the two paths is the
 * call that goes out.
 *
 * So each capability is pinned three ways: it appears on the contribution
 * only when the realm declared it; the call that leaves names the method it
 * claims to be; and its reply is validated by ITS validator, not a sibling's.
 */
describe("negotiated history methods are wired, not merely shaped", () => {
  const page = { offset: 0, limit: 10 };

  it("a realm that declares nothing gets no negotiated method", async () => {
    const h = dispatchHarness();
    await h.dispatch.call("agents.register", [
      1,
      { ...agentEntry, hasHistory: true },
    ]);
    const history = present(h.agent().history, "the agent's history");
    // A standing proxy would make every old guest look capable and get it
    // asked for a call it throws on.
    expect(typeof history.transcriptPage).toBe("undefined");
    expect(typeof history.listing).toBe("undefined");
    // The four unconditional ones are always there.
    expect(typeof history.transcript).toBe("function");
    expect(typeof history.describe).toBe("function");
  });

  it("a declared method appears — and a sibling's declaration does not bring it", async () => {
    const withPage = dispatchHarness();
    await withPage.dispatch.call("agents.register", [
      1,
      { ...agentEntry, hasHistory: true, hasTranscriptPage: true },
    ]);
    const pageHistory = present(withPage.agent().history, "the agent's history");
    expect(typeof pageHistory.transcriptPage).toBe("function");
    expect(typeof pageHistory.listing).toBe("undefined");

    const withListing = dispatchHarness();
    await withListing.dispatch.call("agents.register", [
      1,
      { ...agentEntry, hasHistory: true, hasListing: true },
    ]);
    const listingHistory = present(withListing.agent().history, "the agent's history");
    expect(typeof listingHistory.listing).toBe("function");
    expect(typeof listingHistory.transcriptPage).toBe("undefined");
  });

  it("the call that goes out names transcriptPage, not transcript", async () => {
    const h = dispatchHarness();
    await h.dispatch.call("agents.register", [
      1,
      { ...agentEntry, hasHistory: true, hasTranscriptPage: true },
    ]);
    const history = present(h.agent().history, "the agent's history");
    const asked = present(history.transcriptPage, "the transcriptPage method")("/store/s-1", page);

    // THIS is the assertion the fallback cannot satisfy: the legacy path
    // would have put "transcript" on the wire for the same visible result.
    expect(h.pushes[0].payload).toEqual({
      agentId: "gemini",
      method: "transcriptPage",
      args: ["/store/s-1", page],
    } satisfies WireAgentHistoryCall);

    await h.settleHistory(0, {
      entries: [{ role: "user", text: "hi" }],
      shortfall: [{ kind: "bytes", size: 40, readBytes: 8 }],
    });
    await expect(asked).resolves.toEqual({
      entries: [{ role: "user", text: "hi" }],
      shortfall: [{ kind: "bytes", size: 40, readBytes: 8 }],
    });
  });

  it("the shortfall survives the crossing — the boundary rebuilds it, not drops it", async () => {
    const h = dispatchHarness();
    await h.dispatch.call("agents.register", [
      1,
      { ...agentEntry, hasHistory: true, hasTranscriptPage: true },
    ]);
    const history = present(h.agent().history, "the agent's history");
    const asked = present(history.transcriptPage, "the transcriptPage method")("/store/s-1", page);
    await h.settleHistory(0, {
      entries: [],
      shortfall: [
        { kind: "turns", total: 900, returned: 0 },
        { kind: "parts", unreadableParts: 2 },
      ],
      forkedAt: "a field the boundary must drop",
    });
    await expect(asked).resolves.toEqual({
      entries: [],
      shortfall: [
        { kind: "turns", total: 900, returned: 0 },
        { kind: "parts", unreadableParts: 2 },
      ],
    });
  });

  it("each method is validated by ITS validator — a page shape is not a transcript", async () => {
    const h = dispatchHarness();
    await h.dispatch.call("agents.register", [
      1,
      { ...agentEntry, hasHistory: true, hasTranscriptPage: true },
    ]);

    // A bare array is what `transcript` returns. Answering `transcriptPage`
    // with it must fail: if the two were cross-wired, or either replaced by a
    // pass-through, this is the only test that would notice — both
    // validators are unit-tested and both would still be green.
    const history = present(h.agent().history, "the agent's history");
    const asPage = present(history.transcriptPage, "the transcriptPage method")("/store/s-1", page);
    await h.settleHistory(0, [{ role: "user", text: "hi" }]);
    await expect(asPage).rejects.toThrow("malformed");

    // And the mirror: the page's own shape is not a valid transcript.
    const asTranscript = history.transcript("/store/s-1", page);
    await h.settleHistory(1, { entries: [{ role: "user", text: "hi" }] });
    await expect(asTranscript).rejects.toThrow("malformed");
  });

  it("listing rides the same three rails — the older capability, same trap", async () => {
    const h = dispatchHarness();
    await h.dispatch.call("agents.register", [
      1,
      { ...agentEntry, hasHistory: true, hasListing: true },
    ]);
    const history = present(h.agent().history, "the agent's history");
    const asked = present(history.listing, "the listing method")();
    expect(h.pushes[0].payload).toEqual({
      agentId: "gemini",
      method: "listing",
      args: [],
    } satisfies WireAgentHistoryCall);

    // `list` answers with a bare array; `listing` must refuse it, or a
    // cross-wired validator would hand the host a prune permit it never got.
    await h.settleHistory(0, []);
    await expect(asked).rejects.toThrow("malformed");
  });
});
