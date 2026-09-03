import { describe, expect, it } from "vitest";
import type { ArtifactMetaRow } from "../../ipc/artifacts";
import { fateOf, type RowRef } from "./rowRef";

const row = (id: string, generation: string): ArtifactMetaRow => ({
  id,
  title: `The ${id}`,
  versionCount: 2,
  updatedAt: 1_700_000_000_000,
  generation,
});

const held: RowRef = { workspaceId: "ws-1", id: "draft", generation: "gen-a" };

describe("fateOf", () => {
  it("stands while its own row is there, unchanged", () => {
    expect(fateOf(held, "ws-1", [row("draft", "gen-a"), row("other", "gen-b")])).toBe(
      "stands",
    );
  });

  it("is gone when the workspace moved under it", () => {
    // `workspace.switch` is an agent command, so this happens without the
    // user — and ws-2 may well have a `draft` of its own.
    expect(fateOf(held, "ws-2", [row("draft", "gen-z")])).toBe("gone");
  });

  it("is gone when the id came to mean another artifact", () => {
    // A resurrection: same name, different thing.
    expect(fateOf(held, "ws-1", [row("draft", "gen-resurrected")])).toBe("gone");
  });

  it("is gone when the row left the list", () => {
    expect(fateOf(held, "ws-1", [row("other", "gen-b")])).toBe("gone");
  });

  it("is unknown while a read is in flight, which is not gone", () => {
    // Dropping on `unknown` would close a question under the user's hand
    // every time an agent published something unrelated.
    expect(fateOf(held, "ws-1", null)).toBe("unknown");
  });
});
