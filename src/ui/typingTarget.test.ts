// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { isTypingTarget } from "./typingTarget";

describe("isTypingTarget", () => {
  it("is a field, an area, or inside an editable region — not a button, the page, or nothing", () => {
    const at = (html: string, selector: string) => {
      document.body.innerHTML = html;
      return document.querySelector(selector);
    };
    expect(isTypingTarget(at("<input>", "input"))).toBe(true);
    expect(isTypingTarget(at("<textarea></textarea>", "textarea"))).toBe(true);
    expect(isTypingTarget(at("<div contenteditable='true'><b>x</b></div>", "b"))).toBe(true);
    expect(isTypingTarget(at("<button>x</button>", "button"))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
