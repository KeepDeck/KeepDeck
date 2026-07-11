import { afterEach, describe, expect, it, vi } from "vitest";
import {
  requestOpen,
  subscribeOpenRequests,
  takeOpenRequest,
} from "./openRequests";

afterEach(() => {
  takeOpenRequest(); // drain module state between tests
});

describe("openRequests", () => {
  it("parks one request; taking it consumes it", () => {
    requestOpen({ path: "/repo/a.md" });
    expect(takeOpenRequest()).toEqual({ path: "/repo/a.md" });
    expect(takeOpenRequest()).toBeNull();
  });

  it("latest wins — a second request before the consumer wakes replaces the first", () => {
    requestOpen({ path: "/repo/a.md" });
    requestOpen({ path: "/repo/b.md", root: "/repo" });
    expect(takeOpenRequest()).toEqual({ path: "/repo/b.md", root: "/repo" });
  });

  it("wakes subscribers per request, and stops after unsubscribe", () => {
    const woke = vi.fn();
    const unsubscribe = subscribeOpenRequests(woke);
    requestOpen({ path: "/repo/a.md" });
    expect(woke).toHaveBeenCalledTimes(1);
    unsubscribe();
    requestOpen({ path: "/repo/b.md" });
    expect(woke).toHaveBeenCalledTimes(1);
  });
});
