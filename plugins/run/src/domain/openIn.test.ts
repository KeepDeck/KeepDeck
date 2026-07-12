import { describe, expect, it } from "vitest";
import { DEFAULT_OPEN_APP, knownOpenApp, OPEN_APPS } from "./openIn";

describe("knownOpenApp", () => {
  it("passes a listed app through", () => {
    expect(knownOpenApp("IntelliJ IDEA")).toBe("IntelliJ IDEA");
  });

  it("falls back to the default for an unknown name", () => {
    // A stored pick can outlive the list it was made from.
    expect(knownOpenApp("Sublime Text")).toBe(DEFAULT_OPEN_APP);
  });

  it("falls back for non-string junk out of the schemaless slot", () => {
    expect(knownOpenApp(undefined)).toBe(DEFAULT_OPEN_APP);
    expect(knownOpenApp([{ id: "run-1" }])).toBe(DEFAULT_OPEN_APP);
  });

  it("defaults to the first listed app", () => {
    expect(DEFAULT_OPEN_APP).toBe(OPEN_APPS[0]);
  });
});
