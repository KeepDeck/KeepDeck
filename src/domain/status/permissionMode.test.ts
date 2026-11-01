import { describe, expect, it } from "vitest";
import { reduceStatus, type PaneStatus } from "./activity";
import { reduceMode } from "./permissionMode";

const said = (mode: "yolo" | "auto" | "ask", at: number) => ({ kind: "permission-mode" as const, at, mode });

describe("reduceMode", () => {
  it("takes the first word the agent says", () => {
    expect(reduceMode(null, said("auto", 10))).toEqual({ mode: "auto", at: 10 });
  });

  it("takes a newer word, and a word of the same instant that comes later", () => {
    expect(reduceMode({ mode: "yolo", at: 10 }, said("auto", 20))).toEqual({ mode: "auto", at: 20 });
    expect(reduceMode({ mode: "yolo", at: 10 }, said("ask", 10))).toEqual({ mode: "ask", at: 10 });
  });

  it("leaves the mode as it is for a word older than the one in hand", () => {
    const current = { mode: "auto" as const, at: 20 };
    expect(reduceMode(current, said("yolo", 15))).toBe(current);
  });

  it("moves no activity: the pane does what it did, and a pane nobody reported on stays unheard of", () => {
    const working: PaneStatus = { activity: { state: "working", since: 5 }, openAgentTurns: new Set(), heldEnd: null };
    expect(reduceStatus(working, said("yolo", 10))).toBe(working);
    expect(reduceStatus(null, said("yolo", 10))).toBeNull();
  });

  it("lets a repeat move the time forward, so an echo trailing the repeat cannot undo it", () => {
    // The agent said yolo at 10 and again at 20; a record from 15 saying
    // auto trails the second word and must not stand over it.
    const repeated = reduceMode({ mode: "yolo", at: 10 }, said("yolo", 20));
    expect(reduceMode(repeated, said("auto", 15))).toEqual({ mode: "yolo", at: 20 });
  });
});
