// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@keepdeck/plugin-api";
import { setRuntime } from "../runtime";
import type { ChangeRow } from "../domain/status";
import { DiffPeek } from "./DiffPeek";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const TS_DIFF = [
  "@@ -1,3 +1,3 @@",
  ' import { app } from "./app";',
  "-const port = 3000;",
  "+const port = 8080; // changed",
  "@@ -9 +9 @@",
  "-export default app;",
  "+export default { app };",
  "\\ No newline at end of file",
  "",
].join("\n");

function makeCtx(diffText: string): PluginContext {
  return {
    services: {
      git: { diffFile: vi.fn(async () => diffText) },
      fs: { readFile: vi.fn() },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as PluginContext;
}

const changedRow = (path: string): ChangeRow => ({
  path,
  origPath: null,
  code: "M",
  kind: "unstaged",
});

const rowTexts = () =>
  [...document.querySelectorAll(".git__linetext")].map((n) => n.textContent);

/** Poll inside act — tokenization compiles real grammars, its latency is
 * genuine work, not a missing flush. */
async function settle(ready: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("settle: condition never held");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
}

describe("DiffPeek", () => {
  let host: HTMLElement;
  let root: Root;

  const mount = async (row: ChangeRow, diffText: string) => {
    setRuntime(makeCtx(diffText));
    await act(async () => {
      root.render(
        createElement(DiffPeek, {
          repo: "/repo",
          view: {
            kind: "file",
            row,
            changeSet: { kind: "worktree", groups: null },
          },
          version: 1,
          onSelect: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    await act(async () => {});
  };

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    setRuntime(null);
  });

  it("colors a known language's diff lines without changing their text", async () => {
    await mount(changedRow("src/main.ts"), TS_DIFF);
    const plain = rowTexts();
    await settle(
      () => document.querySelectorAll(".git__linetext span[style]").length > 0,
    );
    // Coloring must not change a single visible character of any row —
    // added, deleted, context, or meta.
    expect(rowTexts()).toEqual(plain);
    expect(plain).toContain("const port = 8080; // changed");
  });

  it("keeps the meta line dim — no colored runs on it", async () => {
    await mount(changedRow("src/main.ts"), TS_DIFF);
    await settle(
      () => document.querySelectorAll(".git__linetext span[style]").length > 0,
    );
    const meta = document.querySelector(".git__diffrow--meta .git__linetext")!;
    expect(meta.querySelectorAll("span[style]").length).toBe(0);
    expect(meta.textContent).toContain("No newline");
  });

  it("fills only the old gutter on a del and only the new on an add", async () => {
    await mount(changedRow("src/main.ts"), TS_DIFF);
    const gutters = (row: Element) =>
      [...row.querySelectorAll(".git__lineno")].map((n) => n.textContent);
    // With the ± column gone, which gutter holds a number is the diff's only
    // hue-free add/del cue — this asserts the invariant the CSS leans on.
    expect(gutters(document.querySelector(".git__diffrow--del")!)).toEqual([
      "2",
      "",
    ]);
    expect(gutters(document.querySelector(".git__diffrow--add")!)).toEqual([
      "",
      "2",
    ]);
  });

  it("renders an unknown language's diff plain", async () => {
    await mount(
      changedRow("LICENSE"),
      "@@ -1 +1 @@\n-old words\n+new words\n",
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(
      document.querySelectorAll(".git__linetext span[style]").length,
    ).toBe(0);
    expect(rowTexts()).toContain("new words");
  });

  it("a history scope with no files leaves the body blank; the rail carries the note", async () => {
    // A waiting scope whose file list resolves empty: the rail says
    // "Nothing changed here." and the body stays blank — no perpetual
    // "Loading…" beside it (the same holds for a fetch error).
    const diffFile = vi.fn(async () => TS_DIFF);
    const changedFiles = vi.fn(async () => []);
    setRuntime({
      services: {
        git: { diffFile, changedFiles },
        fs: { readFile: vi.fn() },
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as PluginContext);
    await act(async () => {
      root.render(
        createElement(DiffPeek, {
          repo: "/repo",
          view: {
            kind: "waiting",
            scope: { kind: "commit", sha: "abc1234def", subject: "add feature" },
          },
          version: 1,
          onSelect: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    await act(async () => {});

    // No file to diff; the header carries the commit label.
    expect(diffFile).not.toHaveBeenCalled();
    expect(host.textContent).toContain("add feature");
    // The rail owns the note; the body is blank — never "Loading…".
    expect(host.querySelector(".peek__aside")?.textContent).toContain(
      "Nothing changed here.",
    );
    expect(host.querySelector(".peek__body")?.textContent).not.toContain(
      "Loading…",
    );
  });

  it("seeds the first file of a history scope the moment the rail loads it", async () => {
    // The seed wiring lives in the rail; this localizes it. The diff fetch
    // is the parent's job (the harness keeps the view waiting), so this
    // proves the onSelect hand-off in isolation.
    const diffFile = vi.fn(async () => TS_DIFF);
    const changedFiles = vi.fn(async () => [
      { path: "src/a.ts", origPath: null, code: "A" },
      { path: "src/b.ts", origPath: null, code: "M" },
    ]);
    const onSelect = vi.fn();
    setRuntime({
      services: {
        git: { diffFile, changedFiles },
        fs: { readFile: vi.fn() },
      },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as PluginContext);
    await act(async () => {
      root.render(
        createElement(DiffPeek, {
          repo: "/repo",
          view: {
            kind: "waiting",
            scope: { kind: "commit", sha: "abc1234def", subject: "add feature" },
          },
          version: 1,
          onSelect,
          onClose: vi.fn(),
        }),
      );
    });
    await act(async () => {});

    // The first file is handed up as the seeded row — range-diffed (kind
    // "history"), never the index. Exactly once: the rail's current guard
    // stops a re-seed even though this harness never advances the view.
    expect(changedFiles).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith({
      path: "src/a.ts",
      origPath: null,
      code: "A",
      kind: "history",
    });
    expect(diffFile).not.toHaveBeenCalled();
  });
});
