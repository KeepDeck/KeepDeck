import { describe, expect, it } from "vitest";
import { oneAtATime, publishFiles } from "./publish.ts";

function recording() {
  const calls: string[] = [];
  return {
    calls,
    fsWrite: {
      writeFile: async (path: string, text: string) => void calls.push(`write ${path} ${text}`),
      remove: async (path: string) => void calls.push(`remove ${path}`),
      move: async (src: string, dst: string) => void calls.push(`move ${src} -> ${dst}`),
    },
  };
}

describe("publishFiles", () => {
  it("clears a stale build, writes every file aside, then replaces the directory whole", async () => {
    const r = recording();
    await publishFiles(r.fsWrite, "/d/plugin", [
      { path: ".claude-plugin/plugin.json", text: "{}" },
      { path: "skills/a/SKILL.md", text: "A" },
    ]);
    expect(r.calls).toEqual([
      "remove /d/plugin.tmp",
      "write /d/plugin.tmp/.claude-plugin/plugin.json {}",
      "write /d/plugin.tmp/skills/a/SKILL.md A",
      "move /d/plugin.tmp -> /d/plugin",
    ]);
  });

  it("refuses a path that would leave the directory, before anything is published", async () => {
    for (const path of ["../escape", "a/../../b", "/abs", "a//b"]) {
      const r = recording();
      await expect(publishFiles(r.fsWrite, "/d/x", [{ path, text: "" }])).rejects.toThrow("not a path inside");
      expect(r.calls.some((call) => call.startsWith("move"))).toBe(false);
    }
  });
});

describe("oneAtATime", () => {
  it("runs work for one key in order, and other keys alongside", async () => {
    const serial = oneAtATime();
    const log: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const a1 = serial("a", async () => {
      await held;
      log.push("a1");
    });
    const a2 = serial("a", async () => void log.push("a2"));
    const b1 = serial("b", async () => void log.push("b1"));
    await b1;
    expect(log).toEqual(["b1"]);
    release();
    await Promise.all([a1, a2]);
    expect(log).toEqual(["b1", "a1", "a2"]);
  });

  it("lets a failure answer its caller without stalling the next", async () => {
    const serial = oneAtATime();
    const failed = serial("k", async () => Promise.reject(new Error("no")));
    await expect(failed).rejects.toThrow("no");
    await expect(serial("k", async () => 1)).resolves.toBe(1);
  });
});
