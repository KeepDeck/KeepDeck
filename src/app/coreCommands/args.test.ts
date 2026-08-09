import { describe, expect, it } from "vitest";
import { requiredStr, str, text } from "./args";

/**
 * The three readers' own suite.
 *
 * They had none: the trim rule was pinned incidentally by one command's cases,
 * and the blank refusal's wording was copied into three more — a rule with four
 * assertions and no owner, so rewording it broke three suites and regressing the
 * trim would have gone unnoticed everywhere except `skills.create`.
 *
 * What the command suites keep is the WIRING fact — this handler reads this
 * argument with this kind of reader — which is per-call-site and belongs there.
 * The semantics are here.
 */
describe("reading a string argument", () => {
  describe("str — optional", () => {
    it("trims, and reads blank as absent", () => {
      // A caller that sent "  " meant to send nothing; the alternative is passing
      // whitespace down as if it were a name.
      expect(str({ a: "  spaced  " }, "a")).toBe("spaced");
      expect(str({ a: "   " }, "a")).toBeUndefined();
      expect(str({ a: "" }, "a")).toBeUndefined();
      expect(str({}, "a")).toBeUndefined();
    });

    it("ignores a value of the wrong type rather than coercing it", () => {
      // The registry has already refused a wrong type; if one arrives anyway,
      // `String(42)` would invent an identifier nobody asked for.
      expect(str({ a: 42 }, "a")).toBeUndefined();
      expect(str({ a: true }, "a")).toBeUndefined();
    });
  });

  describe("requiredStr — an identifier", () => {
    it("trims, and REFUSES blank", () => {
      expect(requiredStr({ a: " review " }, "a")).toBe("review");
      for (const blank of ["", "   ", "\t"]) {
        expect(() => requiredStr({ a: blank }, "a")).toThrow('argument "a" must not be blank');
      }
    });

    it("refuses a missing one too, in the same words", () => {
      // Reachable only from a caller that skips the registry — a suite driving a
      // handler directly. One sentence either way beats two.
      expect(() => requiredStr({}, "a")).toThrow('argument "a" must not be blank');
    });
  });

  describe("text — content", () => {
    it("keeps whitespace, because whitespace is part of the value", () => {
      // The case that makes the three-way split necessary: a skill's body and a
      // line sent to a terminal are content, and trimming them edits what the
      // caller wrote.
      expect(text({ a: "  keep  " }, "a")).toBe("  keep  ");
      expect(text({ a: " " }, "a")).toBe(" ");
      expect(text({ a: "line\n\n" }, "a")).toBe("line\n\n");
    });

    it("answers empty for a missing or wrong-typed value", () => {
      expect(text({}, "a")).toBe("");
      expect(text({ a: 1 }, "a")).toBe("");
    });
  });

  it("leaves BLANKNESS to these readers and not to the registry", () => {
    // The boundary the module exists to state: `""` passes `required` at the
    // registry, because whether whitespace is a value depends on what the argument
    // IS — and only the handler knows. `requiredStr` and `text` are the two
    // opposite answers, and having both is the point.
    expect(() => requiredStr({ a: " " }, "a")).toThrow();
    expect(text({ a: " " }, "a")).toBe(" ");
  });
});
