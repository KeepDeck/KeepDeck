import { describe, expect, it, vi } from "vitest";
import { animateTeamList, type FrameClock } from "./stripTeamsMotion";

/** A clock the test steps: frames run when `tick` says so. */
function steppedClock() {
  let time = 0;
  let queue: [number, (t: number) => void][] = [];
  let next = 1;
  const clock: FrameClock = {
    now: () => time,
    frame: (callback) => {
      const id = next++;
      queue.push([id, callback]);
      return id;
    },
    cancel: (id) => {
      queue = queue.filter(([queued]) => queued !== id);
    },
  };
  const tick = (ms: number) => {
    time += ms;
    const due = queue;
    queue = [];
    for (const [, callback] of due) callback(time);
  };
  return { clock, tick, pending: () => queue.length };
}

const target = (scrollTop = 0) => ({ block: { style: { height: "" } }, list: { scrollTop } });

describe("a team list's motion", () => {
  it("moves the height and the scroll on ONE curve, landing together", () => {
    const { clock, tick } = steppedClock();
    const t = target(100);
    animateTeamList({ ...t, from: 0, to: 200, scrollTo: 150, durationMs: 100 }, clock);
    expect(t.block.style.height).toBe("0px");
    tick(50);
    // Half the time, one eased progress for both: the scroll has travelled
    // the same share of its way as the height of its.
    const heightShare = parseFloat(t.block.style.height) / 200;
    const scrollShare = (t.list.scrollTop - 100) / 50;
    expect(heightShare).toBeGreaterThan(0.5);
    expect(scrollShare).toBeCloseTo(heightShare, 10);
    tick(50);
    expect(t.block.style.height).toBe("200px");
    expect(t.list.scrollTop).toBe(150);
  });

  it("leaves the scroll alone when there is nowhere to go", () => {
    const { clock, tick } = steppedClock();
    const t = target(40);
    animateTeamList({ ...t, from: 120, to: 0, scrollTo: null, durationMs: 100 }, clock);
    tick(100);
    expect(t.block.style.height).toBe("0px");
    expect(t.list.scrollTop).toBe(40);
  });

  it("lands at once with no duration — reduced motion", () => {
    const { clock, pending } = steppedClock();
    const t = target();
    const done = vi.fn();
    animateTeamList({ ...t, from: 0, to: 90, scrollTo: 30, durationMs: 0 }, clock, done);
    expect(t.block.style.height).toBe("90px");
    expect(t.list.scrollTop).toBe(30);
    expect(done).toHaveBeenCalledTimes(1);
    expect(pending()).toBe(0);
  });

  it("stops where it is, so a motion the other way starts from there", () => {
    const { clock, tick, pending } = steppedClock();
    const t = target();
    const done = vi.fn();
    const motion = animateTeamList({ ...t, from: 0, to: 100, scrollTo: null, durationMs: 100 }, clock, done);
    tick(30);
    const reached = t.block.style.height;
    motion.stop();
    tick(100);
    expect(t.block.style.height).toBe(reached);
    expect(parseFloat(reached)).toBeGreaterThan(0);
    expect(parseFloat(reached)).toBeLessThan(100);
    expect(done).not.toHaveBeenCalled();
    expect(pending()).toBe(0);
  });

  it("finishes at once when told to, and says so only once", () => {
    const { clock, tick, pending } = steppedClock();
    const t = target();
    const done = vi.fn();
    const { finish } = animateTeamList({ ...t, from: 0, to: 90, scrollTo: null, durationMs: 100 }, clock, done);
    tick(10);
    finish();
    expect(t.block.style.height).toBe("90px");
    expect(pending()).toBe(0);
    finish();
    tick(200);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("stops writing the scroll once it is released, and keeps moving the height", () => {
    const { clock, tick } = steppedClock();
    const t = target(0);
    const motion = animateTeamList({ ...t, from: 0, to: 100, scrollTo: 100, durationMs: 100 }, clock);
    tick(30);
    const reached = t.list.scrollTop;
    motion.releaseScroll();
    // Another owner writes the scroll now; this motion must leave it be.
    t.list.scrollTop = 7;
    tick(70);
    expect(t.list.scrollTop).toBe(7);
    expect(t.block.style.height).toBe("100px");
    expect(reached).toBeGreaterThan(0);
  });
});
