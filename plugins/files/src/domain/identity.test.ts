import { describe, expect, it } from "vitest";
import { previewKey } from "./identity";

describe("previewKey", () => {
  it("a document and its source are two things to read", () => {
    // Same path, and nothing about how they render tells them apart.
    expect(previewKey("/repo/README.md", true)).not.toBe(
      previewKey("/repo/README.md", false),
    );
  });

  it("the same file in the same rendering is the same thing", () => {
    expect(previewKey("/repo/a.ts", false)).toBe(previewKey("/repo/a.ts", false));
    expect(previewKey("/repo/a.ts", false)).not.toBe(
      previewKey("/repo/b.ts", false),
    );
  });

  it("a path cannot spell out another file's rendering suffix", () => {
    // Under a printable separator these two would collide.
    expect(previewKey("/repo/a.ts\0document", false)).not.toBe(
      previewKey("/repo/a.ts", true),
    );
  });
});
