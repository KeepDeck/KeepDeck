import { describe, expect, it } from "vitest";
import { WELCOME_AT_START, welcomeStep, type WelcomeState } from "./welcomeFlow";

describe("the welcome screen's steps", () => {
  const confirming: WelcomeState = { step: { kind: "confirm", dir: "/repo" }, showAll: true };

  it("goes from the choice to confirming the folder picked or the project clicked", () => {
    expect(welcomeStep(WELCOME_AT_START, { type: "picked", dir: "/repo" })).toEqual({ step: { kind: "confirm", dir: "/repo" }, showAll: false });
  });

  it("stays where it is when the picker closes without a folder", () => {
    expect(welcomeStep(WELCOME_AT_START, { type: "picked", dir: null })).toBe(WELCOME_AT_START);
  });

  it("goes back to the choice, the list as it was", () => {
    expect(welcomeStep(confirming, { type: "back" })).toEqual({ step: { kind: "choose" }, showAll: true });
    expect(welcomeStep(WELCOME_AT_START, { type: "back" })).toBe(WELCOME_AT_START);
  });

  it("shows every recent project once asked, and starts over after a workspace is made", () => {
    expect(welcomeStep(WELCOME_AT_START, { type: "showAll" }).showAll).toBe(true);
    expect(welcomeStep(confirming, { type: "reset" })).toBe(WELCOME_AT_START);
  });
});
