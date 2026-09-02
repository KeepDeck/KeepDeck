// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { appCss } from "./testSupport";

/**
 * The registry's body is the one box that shows four things within
 * milliseconds of each other — loading, empty, a store's refusal, a short
 * list. Both rules here were user-visible regressions in a row: without a
 * floor the card resized on every read, and with a floor but no centring
 * the one-line answers hung from its ceiling.
 */
function mountDialog() {
  const source = document.createElement("style");
  source.textContent = appCss;
  document.head.append(source);

  const surface = document.createElement("div");
  surface.className = "form artifacts";
  const body = document.createElement("div");
  body.className = "artifacts__body";
  const placeholder = document.createElement("div");
  placeholder.className = "artifacts__placeholder";
  body.append(placeholder);
  surface.append(body);
  document.body.append(surface);

  return { body, placeholder };
}

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
});

describe("Artifacts registry layout", () => {
  it("reserves a floor, so the card does not resize between states", () => {
    const { body } = mountDialog();
    const floor = getComputedStyle(body).minHeight;
    expect(floor).toMatch(/^\d+px$/);
    expect(Number.parseFloat(floor)).toBeGreaterThan(0);
  });

  it("centres the placeholder in that floor instead of hanging it from the top", () => {
    const { placeholder } = mountDialog();
    const style = getComputedStyle(placeholder);
    // Fills the reserved seat…
    expect(style.flexGrow).toBe("1");
    // …and sits in the middle of it. The list keeps its own alignment:
    // rows start at the top, which is why this belongs to the placeholder
    // rather than to the body.
    expect(style.justifyContent).toBe("center");
  });
});
