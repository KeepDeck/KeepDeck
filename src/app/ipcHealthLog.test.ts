import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIpcHealthLog, type IpcHealthLogDeps } from "./ipcHealthLog";

const EVERY = 1_000;

function harness(pending: () => number | null) {
  const lines: string[] = [];
  const deps: IpcHealthLogDeps = {
    pendingCallbacks: pending,
    uptimeSeconds: () => 42.4,
    info: (message) => lines.push(message),
  };
  return { lines, log: createIpcHealthLog(deps, EVERY) };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("createIpcHealthLog", () => {
  it("writes the pending count and the uptime on every beat", () => {
    let pending = 10;
    const { lines, log } = harness(() => pending);
    vi.advanceTimersByTime(EVERY);
    pending = 250;
    vi.advanceTimersByTime(EVERY);
    expect(lines).toEqual([
      "ipc callbacks pending=10 uptime=42s",
      "ipc callbacks pending=250 uptime=42s",
    ]);
    log.dispose();
  });

  it("writes nothing before the first beat", () => {
    const { lines, log } = harness(() => 1);
    vi.advanceTimersByTime(EVERY - 1);
    expect(lines).toEqual([]);
    log.dispose();
  });

  it("stays silent when there is no IPC glue to read", () => {
    const { lines, log } = harness(() => null);
    vi.advanceTimersByTime(EVERY * 3);
    expect(lines).toEqual([]);
    log.dispose();
  });

  it("stops writing once disposed", () => {
    const { lines, log } = harness(() => 1);
    vi.advanceTimersByTime(EVERY);
    log.dispose();
    vi.advanceTimersByTime(EVERY * 3);
    expect(lines).toHaveLength(1);
  });
});
