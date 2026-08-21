// @vitest-environment happy-dom
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDirPresence } from "./useDirPresence";

const worktreeIpc = vi.hoisted(() => ({
  probeWorktree: vi.fn((_path: string) =>
    Promise.resolve({ exists: true, isWorktree: false, branch: null }),
  ),
}));
vi.mock("../../ipc/worktree", () => worktreeIpc);

let presence: ReadonlyMap<string, boolean> = new Map();
let rendered = 0;

function Probe({ cwds }: { cwds: readonly string[] }) {
  rendered += 1;
  presence = useDirPresence(cwds);
  return null;
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => {});
};

describe("useDirPresence incremental probing", () => {
  let root: Root;
  beforeEach(() => {
    worktreeIpc.probeWorktree.mockClear();
    rendered = 0;
    presence = new Map();
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(document.getElementById("host")!);
  });
  afterEach(() => act(() => root.unmount()));

  const render = (cwds: readonly string[]) =>
    act(async () => root.render(createElement(Probe, { cwds })));

  it("a growing set probes ONLY the added paths — never the known ones again", async () => {
    await render(["/a", "/b"]);
    await flush();
    expect(worktreeIpc.probeWorktree.mock.calls.map((c) => c[0]).sort()).toEqual([
      "/a",
      "/b",
    ]);

    // The page lands: /c joins, /a and /b are already answered.
    await render(["/a", "/b", "/c"]);
    await flush();
    // EXACTLY the added path — not one call for the known ones.
    expect(worktreeIpc.probeWorktree).toHaveBeenCalledTimes(3);
    expect(worktreeIpc.probeWorktree.mock.calls[2][0]).toBe("/c");

    // Page after page: each landing costs only its own new paths. Two
    // more landings, two new paths each — 3 + 2 + 2 calls, never
    // N×pages (which here would already be 5+7).
    await render(["/a", "/b", "/c", "/d", "/e"]);
    await render(["/a", "/b", "/c", "/d", "/e", "/f", "/g"]);
    await flush();
    expect(worktreeIpc.probeWorktree).toHaveBeenCalledTimes(7);

    // And the render sees the WHOLE live set's answers, carried ones
    // included — the map is the set's presence, not the last page's.
    expect(presence.get("/a")).toBe(true);
    expect(presence.get("/g")).toBe(true);
  });

  it("a path that left and RE-ENTERS asks fresh — no forever-cache", async () => {
    await render(["/a", "/b"]);
    await flush();
    expect(worktreeIpc.probeWorktree).toHaveBeenCalledTimes(2);

    // /b leaves the set: its answer may stay carried, but nobody reads
    // it — and when it comes BACK, the file system may have changed
    // while nobody watched, so it asks again.
    await render(["/a"]);
    await flush();
    expect(worktreeIpc.probeWorktree).toHaveBeenCalledTimes(2);

    await render(["/a", "/b"]);
    await flush();
    expect(worktreeIpc.probeWorktree).toHaveBeenCalledTimes(3);
    expect(worktreeIcs_lastPath()).toBe("/b");
  });

  it("the three-state semantics hold: absent false, present true, unknown treated as present", async () => {
    worktreeIpc.probeWorktree.mockImplementation((path: string) =>
      path === "/gone"
        ? Promise.resolve({ exists: false, isWorktree: false, branch: null })
        : Promise.resolve({ exists: true, isWorktree: false, branch: null }),
    );
    await render(["/live", "/gone"]);
    await flush();
    expect(presence.get("/live")).toBe(true);
    expect(presence.get("/gone")).toBe(false);
  });
});

function worktreeIcs_lastPath(): string {
  const calls = worktreeIpc.probeWorktree.mock.calls;
  return calls[calls.length - 1][0] as string;
}
