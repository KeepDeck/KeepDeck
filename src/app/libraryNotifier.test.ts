import { describe, expect, it } from "vitest";
import { createLibraryNotifier } from "./libraryNotifier";

describe("a library's change notifier", () => {
  it("reaches every listener, and stops reaching one that unsubscribed", () => {
    const notifier = createLibraryNotifier();
    const heard: string[] = [];
    const off = notifier.subscribe(() => heard.push("a"));
    notifier.subscribe(() => heard.push("b"));
    notifier.notify();
    off();
    notifier.notify();
    expect(heard).toEqual(["a", "b", "b"]);
  });

  it("survives a listener that throws, and still reaches the next one", () => {
    const notifier = createLibraryNotifier();
    let reached = false;
    notifier.subscribe(() => {
      throw new Error("a view blew up");
    });
    notifier.subscribe(() => {
      reached = true;
    });
    expect(() => notifier.notify()).not.toThrow();
    expect(reached).toBe(true);
  });

  it("does not re-enter: a listener that notifies from inside is not heard again", () => {
    // A listener that writes would be told about its own write, and nothing
    // would bound the chain.
    const notifier = createLibraryNotifier();
    let calls = 0;
    notifier.subscribe(() => {
      calls += 1;
      notifier.notify();
    });
    notifier.notify();
    expect(calls).toBe(1);
  });

  it("does not hear a listener added mid-notification until the next one", () => {
    const notifier = createLibraryNotifier();
    let late = 0;
    notifier.subscribe(() => {
      notifier.subscribe(() => {
        late += 1;
      });
    });
    notifier.notify();
    expect(late).toBe(0);
    notifier.notify();
    expect(late).toBe(1);
  });
});
