import { describe, expect, it } from "vitest";
import { BUNDLED_NOTICE, bundledUnlockHint } from "./bundledTier";

describe("bundledUnlockHint", () => {
  it("explains the dead tier while the feature is off", () => {
    expect(bundledUnlockHint(false)).toContain("Fleet artifacts");
  });

  it("says nothing while the feature is on — there is nothing to unlock", () => {
    expect(bundledUnlockHint(true)).toBeUndefined();
  });

  it("takes a BOOLEAN, so 'unread settings' is the caller's call to make", () => {
    // The unsettled boot load is not a third state here: the controller
    // resolves null to ON before asking, so no hint blames a setting
    // nobody has read yet. Keeping that decision out of this function is
    // what lets the rule be tested without a store.
    expect(bundledUnlockHint(true)).toBeUndefined();
  });
});

describe("BUNDLED_NOTICE", () => {
  it("names the tier and points at the customization path", () => {
    // Selection IS the affordance — the design's verdict was no fork
    // machinery and no buttons, so the notice has to say so in words.
    expect(BUNDLED_NOTICE).toContain("read-only");
    expect(BUNDLED_NOTICE).toContain("create your own skill");
    expect(BUNDLED_NOTICE).toContain("selectable");
  });
});
