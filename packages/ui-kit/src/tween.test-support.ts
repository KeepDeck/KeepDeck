import type { FrameClock } from "./tween";

/** A clock a test steps: queued frames run when `tick` says, at the time
 * it has moved to. */
export function steppedClock() {
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
