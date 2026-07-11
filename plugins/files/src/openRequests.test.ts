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
    requestOpen("/repo/a.md");
    expect(takeOpenRequest()).toBe("/repo/a.md");
    expect(takeOpenRequest()).toBeNull();
  });

  it("latest wins — a second click before the tab mounts replaces the first", () => {
    requestOpen("/repo/a.md");
    requestOpen("/repo/b.md");
    expect(takeOpenRequest()).toBe("/repo/b.md");
  });

  it("wakes subscribers per request, and stops after unsubscribe", () => {
    const woke = vi.fn();
    const unsubscribe = subscribeOpenRequests(woke);
    requestOpen("/repo/a.md");
    expect(woke).toHaveBeenCalledTimes(1);
    unsubscribe();
    requestOpen("/repo/b.md");
    expect(woke).toHaveBeenCalledTimes(1);
  });
});
