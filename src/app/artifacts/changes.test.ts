import { describe, expect, it } from "vitest";
import { createArtifactChanges } from "./changes";

describe("createArtifactChanges", () => {
  it("counts writes so a React reader can compare them", () => {
    // A bare callback cannot drive useSyncExternalStore: it needs a value
    // that CHANGED, and monotonic is the smallest honest one.
    const changes = createArtifactChanges();
    expect(changes.revision()).toBe(0);
    changes.changed();
    changes.changed();
    expect(changes.revision()).toBe(2);
  });

  it("tells every subscriber, and stops telling the one that left", () => {
    const changes = createArtifactChanges();
    const seen: string[] = [];
    const stop = changes.subscribe(() => seen.push("a"));
    changes.subscribe(() => seen.push("b"));

    changes.changed();
    stop();
    changes.changed();

    expect(seen).toEqual(["a", "b", "b"]);
  });

  it("survives a subscriber that unsubscribes inside its own call", () => {
    // React does exactly this when a component unmounts on the update it
    // was just told about; iterating the live set would skip its
    // neighbour or throw.
    const changes = createArtifactChanges();
    const seen: string[] = [];
    const stop = changes.subscribe(() => {
      seen.push("first");
      stop();
    });
    changes.subscribe(() => seen.push("second"));

    changes.changed();

    expect(seen).toEqual(["first", "second"]);
  });
});
