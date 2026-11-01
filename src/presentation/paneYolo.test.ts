import { describe, expect, it } from "vitest";
import { paneRunsYolo, paneYoloStart } from "./paneYolo";

describe("paneYoloStart", () => {
  it("reads the launch off the plan when there is one, and only then", () => {
    expect(paneYoloStart(true, { yolo: true })).toEqual({ launched: true, asked: true });
    expect(paneYoloStart(true, {})).toEqual({ launched: false, asked: true });
    expect(paneYoloStart(true, undefined)).toEqual({ launched: null, asked: true });
    expect(paneYoloStart(undefined, undefined)).toEqual({ launched: null, asked: false });
  });
});

describe("paneRunsYolo", () => {
  it("follows the agent's own word over the launch and the request", () => {
    // Asked for YOLO and launched with it, but a policy — or the user inside
    // the CLI — took it away: the badge goes.
    expect(paneRunsYolo({ said: "auto", launched: true, asked: true })).toBe(false);
    expect(paneRunsYolo({ said: "ask", launched: true, asked: true })).toBe(false);
    // And the other way round: switched INTO it inside the CLI.
    expect(paneRunsYolo({ said: "yolo", launched: false, asked: false })).toBe(true);
  });

  it("before the agent says anything, shows what its process was launched with", () => {
    // Asked for YOLO, launched without it (a plan that threw into a bare
    // launch): no badge.
    expect(paneRunsYolo({ said: null, launched: false, asked: true })).toBe(false);
    expect(paneRunsYolo({ said: null, launched: true, asked: true })).toBe(true);
  });

  it("for a pane with no plan yet, shows what it was asked for", () => {
    expect(paneRunsYolo({ said: null, launched: null, asked: true })).toBe(true);
    expect(paneRunsYolo({ said: null, launched: null, asked: false })).toBe(false);
  });
});
