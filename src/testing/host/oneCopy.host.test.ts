import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, inject, it } from "vitest";
import { useHost } from "./host";

/**
 * One KeepDeck per settings folder, end to end on the app itself: a second
 * kd-host started on the home a first one holds.
 */
describe("one copy per settings folder, on the host", () => {
  const host = useHost();

  /** A second kd-host on `home`: what it says, whether it came up, and how
   * it ended. */
  function second(home: string) {
    const child: ChildProcessWithoutNullStreams = spawn(inject("hostBinary"), [], {
      env: { ...process.env, KEEPDECK_HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let said = "";
    let ready = false;
    child.stderr.on("data", (chunk: Buffer) => (said += chunk.toString()));
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes('"ready":true')) ready = true;
    });
    const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
    return { child, said: () => said, ready: () => ready, exited };
  }

  /** Every file under `root`, with its size and when it last changed. */
  function tree(root: string): Record<string, string> {
    const files: Record<string, string> = {};
    for (const name of readdirSync(root, { recursive: true, encoding: "utf8" })) {
      const stat = statSync(join(root, name));
      if (stat.isFile()) files[name] = `${String(stat.size)}@${String(stat.mtimeMs)}`;
    }
    return files;
  }

  it("refuses a second copy at once, names the first, and lets it write nothing", async () => {
    const before = tree(host().home);
    const started = performance.now();
    const copy = second(host().home);
    const code = await copy.exited;
    expect(code).toBe(3);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(copy.said()).toContain(`pid ${String(host().pid())}`);
    expect(tree(host().home)).toEqual(before);
  });

  it("makes a copy that replaces a holder naming nothing wait for it, and come up once it is gone", async () => {
    // What an older build leaves in its lock: nothing.
    writeFileSync(join(host().home, "lifecycle", "lock"), "");
    const copy = second(host().home);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(copy.child.exitCode, copy.said()).toBeNull();
    expect(copy.ready()).toBe(false);
    process.kill(host().pid(), "SIGKILL");
    await host().until("the replacing copy comes up", () => copy.ready(), 15_000);
    copy.child.stdin.end();
    expect(await copy.exited).toBe(0);
  });
});
