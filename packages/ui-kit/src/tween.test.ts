import { describe, expect, it, vi } from "vitest";
import { easeFold } from "./foldMotion";
import { runTween } from "./tween";
import { steppedClock } from "./tween.test-support";

describe("runTween", () => {
  it("paints from 0 at once, along the folds' curve, and lands on 1 — saying so once", () => {
    const { clock, tick, pending } = steppedClock();
    const painted: number[] = [];
    const done = vi.fn();
    runTween(100, clock, (progress) => painted.push(progress), done);
    expect(painted).toEqual([0]);
    tick(50);
    expect(painted[1]).toBe(easeFold(0.5));
    expect(done).not.toHaveBeenCalled();
    tick(50);
    expect(painted[painted.length - 1]).toBe(1);
    expect(done).toHaveBeenCalledTimes(1);
    expect(pending()).toBe(0);
  });

  it("lands on 1 however late its frame comes — never past it", () => {
    const { clock, tick } = steppedClock();
    const painted: number[] = [];
    runTween(100, clock, (progress) => painted.push(progress));
    tick(5_000);
    expect(painted).toEqual([0, 1]);
  });

  it("lands at once with no duration — reduced motion", () => {
    const { clock, pending } = steppedClock();
    const painted: number[] = [];
    const done = vi.fn();
    runTween(0, clock, (progress) => painted.push(progress), done);
    expect(painted).toEqual([1]);
    expect(done).toHaveBeenCalledTimes(1);
    expect(pending()).toBe(0);
  });

  it("stops where it is, neither landing nor saying so, so a motion the other way starts from there", () => {
    const { clock, tick, pending } = steppedClock();
    const painted: number[] = [];
    const done = vi.fn();
    const tween = runTween(100, clock, (progress) => painted.push(progress), done);
    tick(30);
    tween.stop();
    tick(100);
    expect(painted).toEqual([0, easeFold(0.3)]);
    expect(done).not.toHaveBeenCalled();
    expect(pending()).toBe(0);
  });

  it("finishes at once when told to, and says so only once", () => {
    const { clock, tick, pending } = steppedClock();
    const painted: number[] = [];
    const done = vi.fn();
    const tween = runTween(100, clock, (progress) => painted.push(progress), done);
    tick(10);
    tween.finish();
    expect(painted[painted.length - 1]).toBe(1);
    expect(pending()).toBe(0);
    tween.finish();
    tween.stop();
    tick(200);
    expect(done).toHaveBeenCalledTimes(1);
  });
});
