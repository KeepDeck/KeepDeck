import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Read one flat CSS rule. Settings selectors are deliberately un-nested, so
 * this tiny helper keeps the regression test about layout invariants instead
 * of introducing a CSS parser solely for three declarations. */
const settingsCss = readFileSync(new URL("./settings.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = settingsCss.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  expect(match, `missing ${selector} rule`).not.toBeNull();
  return match![1];
}

describe("Settings layout", () => {
  it("bounds the shared content row instead of letting sections paint into the footer", () => {
    const body = rule(".settings__body");
    expect(body).toMatch(/height:\s*min\(620px,\s*70vh\)/);
    expect(body).toMatch(/grid-template-rows:\s*minmax\(0,\s*1fr\)/);
  });

  it("makes both potentially tall columns own their overflow", () => {
    for (const selector of [".settings__nav", ".settings__section"]) {
      const declarations = rule(selector);
      expect(declarations).toMatch(/min-height:\s*0/);
      expect(declarations).toMatch(/overflow-y:\s*auto/);
    }
  });
});
