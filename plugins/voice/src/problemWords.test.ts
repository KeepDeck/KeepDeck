import { describe, expect, it } from "vitest";
import { problemLine, problemWords } from "./problemWords";

describe("problemWords", () => {
  it("a missing pick says just that (decision №3)", () => {
    expect(problemWords("mic-missing")).toEqual({ title: "Microphone not connected", severity: "warning" });
  });

  it("names the device and what was heard of a cut-off hold", () => {
    expect(problemWords("cut-short", { device: "BY-PM700", seconds: 2 })).toEqual({
      title: "The microphone stopped partway (BY-PM700)",
      body: "Only the first 2.0s were heard.",
      severity: "error",
    });
  });

  it("tells a distorting input to turn the microphone's gain down", () => {
    expect(problemWords("clipping", { device: "BY-PM700" }).body).toMatch(/turn the gain down on the microphone/);
  });

  it("points a withheld or refused mic at the privacy setting", () => {
    expect(problemWords("permission").body).toContain("Privacy & Security");
    expect(problemWords("dead-signal").body).toContain("Privacy & Security");
  });
});

describe("problemLine", () => {
  it("joins title and body, or is the title alone", () => {
    expect(problemLine({ title: "A", body: "B", severity: "error" })).toBe("A — B");
    expect(problemLine({ title: "A", severity: "warning" })).toBe("A");
  });
});
