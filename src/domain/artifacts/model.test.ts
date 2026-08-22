import { describe, expect, it } from "vitest";
import capsJson from "./caps.json";
import {
  CONTENT_CAP_BYTES,
  FILE_CAP_BYTES,
  isArtifactFormat,
  MESSAGE_MAX,
  SLUG_MAX,
  TITLE_MAX,
  validateMessage,
  validateSlug,
  validateTitle,
} from "./model";

describe("isArtifactFormat", () => {
  it("accepts html and rejects everything else, md included", () => {
    // Same guard, inverted on one word: md was a format and is now just
    // another string that is not html — the door must say so rather than
    // accept it and fail later, deeper.
    expect(isArtifactFormat("html")).toBe(true);
    expect(isArtifactFormat("md")).toBe(false);
    expect(isArtifactFormat("pdf")).toBe(false);
    expect(isArtifactFormat("HTML")).toBe(false);
    expect(isArtifactFormat("")).toBe(false);
    expect(isArtifactFormat(null)).toBe(false);
    expect(isArtifactFormat(1)).toBe(false);
  });
});

describe("validateSlug", () => {
  it("accepts the grammar: lowercase, digits, dashes", () => {
    expect(validateSlug("auth-flow")).toBe("auth-flow");
    expect(validateSlug("a")).toBe("a");
    expect(validateSlug("0-9")).toBe("0-9");
    expect(validateSlug("-")).toBe("-");
  });

  it("rejects uppercase, dots, spaces, underscores, separators", () => {
    expect(validateSlug("Auth-Flow")).toBeNull();
    expect(validateSlug("auth.flow")).toBeNull();
    expect(validateSlug("auth flow")).toBeNull();
    expect(validateSlug("auth_flow")).toBeNull();
    expect(validateSlug("auth/flow")).toBeNull();
    expect(validateSlug("auth\\flow")).toBeNull();
    expect(validateSlug("../escape")).toBeNull();
  });

  it("rejects empty and over-length", () => {
    expect(validateSlug("")).toBeNull();
    expect(validateSlug("a".repeat(SLUG_MAX))).toBe("a".repeat(SLUG_MAX));
    expect(validateSlug("a".repeat(SLUG_MAX + 1))).toBeNull();
  });
});

describe("validateTitle", () => {
  it("accepts 1..TITLE_MAX chars", () => {
    expect(validateTitle("x")).toBe("x");
    expect(validateTitle("x".repeat(TITLE_MAX))).toBe("x".repeat(TITLE_MAX));
  });
  it("rejects empty and over-length", () => {
    expect(validateTitle("")).toBeNull();
    expect(validateTitle("x".repeat(TITLE_MAX + 1))).toBeNull();
  });
});

describe("validateMessage", () => {
  it("accepts empty (an iteration without a message is ordinary)", () => {
    expect(validateMessage("")).toBe("");
  });
  it("accepts up to MESSAGE_MAX, rejects past it", () => {
    expect(validateMessage("m".repeat(MESSAGE_MAX))).toBe(
      "m".repeat(MESSAGE_MAX),
    );
    expect(validateMessage("m".repeat(MESSAGE_MAX + 1))).toBeNull();
  });
});

describe("caps are the designed numbers", () => {
  it("content 256 KiB, file 2 MiB", () => {
    expect(CONTENT_CAP_BYTES).toBe(256 * 1024);
    expect(FILE_CAP_BYTES).toBe(2 * 1024 * 1024);
  });

  // The cross-language mirror, pinned: the Rust store asserts its
  // constants against the SAME caps.json (include_str, the mint
  // precedent) — a bump on either side without the shared file fails
  // BOTH suites. The JSON is test-only truth; production stays
  // compile-time on both sides.
  it("the constants equal caps.json — the file Rust mirrors against too", () => {
    const caps = capsJson as Record<string, number>;
    expect(caps.TITLE_MAX).toBe(TITLE_MAX);
    expect(caps.MESSAGE_MAX).toBe(MESSAGE_MAX);
    expect(caps.CONTENT_CAP_BYTES).toBe(CONTENT_CAP_BYTES);
    expect(caps.FILE_CAP_BYTES).toBe(FILE_CAP_BYTES);
  });
});
