// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { appCss } from "./testSupport";

/**
 * Where the registry's steady height lives, and where it must not.
 *
 * Both rules here were user-visible regressions, in this order: a floor
 * on the BODY made a one-row list sit under a card sized for six, and
 * the same floor without centring left the one-line states hanging from
 * its ceiling. The three text states share a size; rows never do.
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
  it("lets a list be exactly as tall as it has rows", () => {
    // A floor here is what put one artifact under a card sized for six.
    const { body } = mountDialog();
    expect(Number.parseFloat(getComputedStyle(body).minHeight || "0")).toBe(0);
  });

  it("gives the text states one size, and centres them in it", () => {
    const { placeholder } = mountDialog();
    const style = getComputedStyle(placeholder);
    // Loading, empty and a refusal replace each other within
    // milliseconds; differing heights read as a flinch.
    expect(Number.parseFloat(style.minHeight)).toBeGreaterThan(0);
    // Fills that seat, and sits in the middle of it rather than on top.
    expect(style.flexGrow).toBe("1");
    expect(style.justifyContent).toBe("center");
  });

  it("clamps a row to two lines with the shared .kd-two-lines, breaking a word longer than the row", () => {
    // One line cut agents' long titles to the same opening words; more
    // than two would let one row crowd out its neighbours. Every row that
    // clamps takes this one class — the artifacts dialog and the task panel.
    mountDialog();
    const title = document.createElement("span");
    title.className = "kd-two-lines";
    document.body.append(title);
    const style = getComputedStyle(title);
    expect(style.getPropertyValue("-webkit-line-clamp")).toBe("2");
    expect(style.overflowWrap).toBe("anywhere");
  });
});
