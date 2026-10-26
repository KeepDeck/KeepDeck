// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginGit } from "@keepdeck/plugin-api";
import { setRuntime, type GitPorts } from "../runtime";
import { gitOf, inertPorts } from "../gitPorts.test-support";
import type { ChangeGroups, ChangeRow } from "../domain/status";
import { DiffPeek } from "./DiffPeek";
import { present } from "@keepdeck/plugin-api/testing";
import { useHighlights } from "@keepdeck/code-kit";

// DiffPeek's contract here is how it places the hook's tokens over diff rows.
// code-kit's own suite exercises the real Shiki grammars and alignment.
vi.mock("@keepdeck/code-kit", async (importOriginal) => {
  const kit = await importOriginal<typeof import("@keepdeck/code-kit")>();
  const useHighlights: typeof kit.useHighlights = vi.fn(
    (texts: readonly string[] | null, lang: string | null) =>
      texts !== null && lang !== null
        ? texts.map((text) =>
            text.split("\n").map((line) => (line === "" ? [] : [{ text: line, color: "#c00" }])),
          )
        : null,
  );
  return { ...kit, useHighlights };
});

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

/** The host's answer for a diff: text under its cap, not cut. */
const diffOf = (text: string) => ({ text, truncated: false });

/** Ports over the git calls a test fakes, and the file read where it has one. */
function portsOf(
  git: Partial<PluginGit>,
  fs: GitPorts["services"]["fs"] = inertPorts().services.fs,
): GitPorts {
  return inertPorts({ services: { git: gitOf(git), fs } });
}

function makeCtx(diffText: string): GitPorts {
  return portsOf({ diffFile: vi.fn(async () => diffOf(diffText)) });
}

const changedRow = (path: string): ChangeRow => ({
  path,
  origPath: null,
  code: "M",
  kind: "unstaged",
});

const rowTexts = () =>
  [...document.querySelectorAll(".git__linetext")].map((n) => n.textContent);

/** The fake services below resolve by microtask. Flush their React commits,
 * with no sleep or wall-clock deadline tied to machine load. */
async function settle(ready: () => boolean) {
  for (let turn = 0; turn < 8 && !ready(); turn++) {
    await act(async () => { await Promise.resolve(); });
  }
  expect(ready()).toBe(true);
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
            changeSet: { kind: "worktree", groups: null, error: null },
          },
          version: 1,
          onSelect: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    await act(async () => {});
  };

  // The peek is never remounted between files — GitTab swaps the row on the
  // mounted component — so the scroll position is free to leak from one file
  // into the next unless something resets it.
  const RAIL_ROWS = [changedRow("src/a.ts"), changedRow("src/b.ts")];

  const railGroups = (rows: ChangeRow[]): ChangeGroups => ({
    conflicted: [],
    staged: [],
    unstaged: rows,
    untracked: [],
    total: rows.length,
  });

  /** Draw the peek on one row of a two-file worktree change set, the way
   * GitTab does: same mounted component, a different `view`. */
  const drawRow = async (
    row: ChangeRow,
    version: number,
    onSelect: (row: ChangeRow) => void,
  ) => {
    await act(async () => {
      root.render(
        createElement(DiffPeek, {
          repo: "/repo",
          view: {
            kind: "file",
            row,
            changeSet: {
              kind: "worktree",
              groups: railGroups(RAIL_ROWS),
              error: null,
            },
          },
          version,
          onSelect,
          onClose: vi.fn(),
        }),
      );
    });
    await act(async () => {});
  };

  /** Draw one file of a drilled-in COMMIT — the case where the diff is read
   * across a revision range rather than against the index. */
  const drawHistoryFile = async (path: string, sha: string, repo = "/repo") => {
    await act(async () => {
      root.render(
        createElement(DiffPeek, {
          repo,
          view: {
            kind: "file",
            row: { path, origPath: null, code: "M", kind: "history" },
            changeSet: {
              kind: "history",
              scope: { kind: "commit", sha, subject: `work on ${path}` },
            },
          },
          version: 1,
          onSelect: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    await act(async () => {});
  };

  /** Deep into a long diff, and off to the side of a wide one. */
  const readerScrolledAway = (body: HTMLElement) => {
    body.scrollTop = 900;
    body.scrollLeft = 140;
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

  it("renders a known language's colored tokens without changing diff text", async () => {
    await mount(changedRow("src/main.ts"), TS_DIFF);
    expect(useHighlights).toHaveBeenCalledWith(expect.any(Array), "typescript");
    expect(document.querySelectorAll(".git__linetext span[style]").length).toBeGreaterThan(0);
    expect(rowTexts().slice(0, 5)).toEqual([
      'import { app } from "./app";',
      "const port = 3000;",
      "const port = 8080; // changed",
      "export default app;",
      "export default { app };",
    ]);
    expect(rowTexts()[5]).toContain("No newline at end of file");
  });

  it("reads both sides of a changed row whole and colors from them, kept with the diff", async () => {
    const OLD = 'import { app } from "./app";\nconst port = 3000;\n';
    const NEW = 'import { app } from "./app";\nconst port = 8080;\n';
    const fileAt = vi.fn(async () => ({ text: OLD, isBinary: false, truncated: false }));
    const readFile = vi.fn(async (path: string) => ({
      path,
      text: NEW,
      isBinary: false,
      size: NEW.length,
      truncated: false,
      readBytes: NEW.length,
    }));
    const raw = '@@ -1,2 +1,2 @@\n import { app } from "./app";\n-const port = 3000;\n+const port = 8080;\n';
    setRuntime(portsOf({ diffFile: vi.fn(async () => diffOf(raw)), fileAt }, { readFile }));
    await act(async () => {
      root.render(
        createElement(DiffPeek, {
          repo: "/repo",
          view: { kind: "file", row: changedRow("src/main.ts"), changeSet: { kind: "worktree", groups: null, error: null } },
          version: 0,
          onSelect: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    await settle(() => document.querySelectorAll(".git__linetext span[style]").length > 0);
    // An unstaged row: the index against the working file.
    expect(fileAt).toHaveBeenCalledWith("/repo", "src/main.ts", undefined);
    expect(readFile).toHaveBeenCalledWith("/repo/src/main.ts");
    expect(vi.mocked(useHighlights)).toHaveBeenLastCalledWith([NEW, OLD], "typescript");
    expect(document.querySelectorAll(".git__linetext span[style]").length).toBe(3);
  });

  it("still shows and colors the diff when a side fails to read — from its hunks", async () => {
    const fileAt = vi.fn(async (): Promise<never> => {
      throw new Error("git exploded");
    });
    const raw = "@@ -1 +1 @@\n-const port = 3000;\n+const port = 8080;\n";
    setRuntime(portsOf({ diffFile: vi.fn(async () => diffOf(raw)), fileAt }));
    await act(async () => {
      root.render(
        createElement(DiffPeek, {
          repo: "/repo",
          view: { kind: "file", row: changedRow("src/main.ts"), changeSet: { kind: "worktree", groups: null, error: null } },
          version: 0,
          onSelect: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    await settle(() => document.querySelectorAll(".git__linetext span[style]").length > 0);
    expect(fileAt).toHaveBeenCalled();
    expect(rowTexts()).toEqual(["const port = 3000;", "const port = 8080;"]);
    // No side: each line colors from its own hunk's side.
    expect(vi.mocked(useHighlights)).toHaveBeenLastCalledWith(
      ["const port = 3000;", "const port = 8080;"],
      "typescript",
    );
    expect(document.querySelector(".peek__note--bad")).toBeNull();
  });

  it("keeps the meta line dim — no colored runs on it", async () => {
    await mount(changedRow("src/main.ts"), TS_DIFF);
    expect(document.querySelectorAll(".git__linetext span[style]").length).toBeGreaterThan(0);
    const meta = present(document.querySelector(".git__diffrow--meta .git__linetext"), "the .git__diffrow--meta .git__linetext element");
    expect(meta.querySelectorAll("span[style]").length).toBe(0);
    expect(meta.textContent).toContain("No newline");
  });

  it("fills only the old gutter on a del and only the new on an add", async () => {
    await mount(changedRow("src/main.ts"), TS_DIFF);
    const gutters = (row: Element) =>
      [...row.querySelectorAll(".git__lineno")].map((n) => n.textContent);
    // Both gutters opt OUT of the peek's selection island, or a copied hunk
    // arrives with line numbers welded into it.
    for (const cell of document.querySelectorAll(".git__lineno")) {
      expect(cell.classList.contains("kd-inert")).toBe(true);
    }
    // With the ± column gone, which gutter holds a number is the diff's only
    // hue-free add/del cue — this asserts the invariant the CSS leans on.
    expect(gutters(present(document.querySelector(".git__diffrow--del"), "the .git__diffrow--del element"))).toEqual([
      "2",
      "",
    ]);
    expect(gutters(present(document.querySelector(".git__diffrow--add"), "the .git__diffrow--add element"))).toEqual([
      "",
      "2",
    ]);
  });

  it("renders an unknown language's diff plain", async () => {
    await mount(
      changedRow("LICENSE"),
      "@@ -1 +1 @@\n-old words\n+new words\n",
    );
    expect(
      document.querySelectorAll(".git__linetext span[style]").length,
    ).toBe(0);
    expect(rowTexts()).toContain("new words");
  });

  it("a history scope with no files leaves the body blank; the rail carries the note", async () => {
    // A waiting scope whose file list resolves empty: the rail says
    // "Nothing changed here." and the body stays blank — no perpetual
    // "Loading…" beside it (the same holds for a fetch error).
    const diffFile = vi.fn(async () => diffOf(TS_DIFF));
    const changedFiles = vi.fn(async () => []);
    setRuntime(portsOf({ diffFile, changedFiles }));
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
    const diffFile = vi.fn(async () => diffOf(TS_DIFF));
    const changedFiles = vi.fn(async () => [
      { path: "src/a.ts", origPath: null, code: "A" },
      { path: "src/b.ts", origPath: null, code: "M" },
    ]);
    const onSelect = vi.fn();
    setRuntime(portsOf({ diffFile, changedFiles }));
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

  it("switching files through the rail starts the next diff at the top", async () => {
    setRuntime(makeCtx(TS_DIFF));
    const onSelect = vi.fn();
    await drawRow(RAIL_ROWS[0], 1, onSelect);
    const body = present(host.querySelector<HTMLElement>(".peek__body"), "the .peek__body element");
    readerScrolledAway(body);

    const rowB = present([
      ...host.querySelectorAll<HTMLElement>(".peek__aside .git__row"),
    ].find((node) => node.textContent?.includes("b.ts")), "the matching item");
    act(() => rowB.click());
    expect(onSelect).toHaveBeenCalledWith(RAIL_ROWS[1]);
    await drawRow(RAIL_ROWS[1], 1, onSelect);

    // Same scroll container throughout — the reset is what puts it back, not
    // a remount and not the loading placeholder happening to be short.
    expect(host.querySelector(".peek__body")).toBe(body);
    expect(body.scrollTop).toBe(0);
    expect(body.scrollLeft).toBe(0);
  });

  it("a watcher refresh re-reads the open diff without moving the reader", async () => {
    const diffFile = vi.fn(async () => diffOf(TS_DIFF));
    setRuntime(portsOf({ diffFile }));
    const onSelect = vi.fn();
    await drawRow(RAIL_ROWS[0], 1, onSelect);
    const body = present(host.querySelector<HTMLElement>(".peek__body"), "the .peek__body element");
    readerScrolledAway(body);

    await drawRow(RAIL_ROWS[0], 2, onSelect);

    // The bump did re-read the file — and left the reader where they were,
    // which is why `version` is kept out of the diff's identity: the working
    // tree moves on its own, and it must not throw anyone back to line one.
    expect(diffFile).toHaveBeenCalledTimes(2);
    expect(body.scrollTop).toBe(900);
    expect(body.scrollLeft).toBe(140);
  });

  it("the same path at another commit is another diff, read and reset", async () => {
    // The case the revision range exists for, and the one nothing about the
    // rendering can distinguish: both commits show `src/main.ts` under an
    // identical name and an identical path line. Only the range differs.
    // Typed params so the range argument is what gets asserted, not `any`.
    const diffFile = vi.fn(
      async (_repo: string, _path: string, range?: { from: string; to?: string }) => {
        void range;
        return diffOf(TS_DIFF);
      },
    );
    const changedFiles = vi.fn(async () => [
      { path: "src/main.ts", origPath: null, code: "M" },
    ]);
    setRuntime(portsOf({ diffFile, changedFiles }));

    await drawHistoryFile("src/main.ts", "aaa1111");
    const body = present(host.querySelector<HTMLElement>(".peek__body"), "the .peek__body element");
    readerScrolledAway(body);

    await drawHistoryFile("src/main.ts", "bbb2222");

    // Read across each commit's own range — the peek is not showing the first
    // commit's hunks under the second one's heading.
    expect(diffFile.mock.calls.map((call) => call[2])).toEqual([
      { from: "aaa1111^", to: "aaa1111" },
      { from: "bbb2222^", to: "bbb2222" },
    ]);
    expect(host.querySelector(".peek__body")).toBe(body);
    expect(body.scrollTop).toBe(0);
    expect(body.scrollLeft).toBe(0);
  });

  it("asks for the old path beside the new one when the row was renamed", async () => {
    // Git pairs a rename only when both paths are in the pathspec; a row that
    // knows its old path hands it over, in a history range and in the index
    // alike. Rows without one keep asking exactly what they always asked —
    // the range test above pins that shape.
    const diffFile = vi.fn(async () => diffOf(TS_DIFF));
    const changedFiles = vi.fn(async () => []);
    setRuntime(portsOf({ diffFile, changedFiles }));

    await act(async () => {
      root.render(
        createElement(DiffPeek, {
          repo: "/repo",
          view: {
            kind: "file",
            row: { path: "src/new.ts", origPath: "src/old.ts", code: "R", kind: "history" },
            changeSet: {
              kind: "history",
              scope: { kind: "commit", sha: "aaa1111", subject: "move it" },
            },
          },
          version: 1,
          onSelect: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    await act(async () => {});
    expect(diffFile).toHaveBeenLastCalledWith("/repo", "src/new.ts", {
      from: "aaa1111^",
      to: "aaa1111",
      origPath: "src/old.ts",
    });

    await act(async () => {
      root.render(
        createElement(DiffPeek, {
          repo: "/repo",
          view: {
            kind: "file",
            row: { path: "src/new.ts", origPath: "src/old.ts", code: "R", kind: "staged" },
            changeSet: { kind: "worktree", groups: railGroups(RAIL_ROWS), error: null },
          },
          version: 1,
          onSelect: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    await act(async () => {});
    expect(diffFile).toHaveBeenLastCalledWith("/repo", "src/new.ts", {
      staged: true,
      origPath: "src/old.ts",
    });
  });

  it("reads an untracked file in a since-fork sweep as a file, not a range diff", async () => {
    // A working-tree range lists untracked files as `?`; git has no diff for
    // them at any range, so the row reads the file the way a status row does.
    const diffFile = vi.fn(async () => diffOf(TS_DIFF));
    const readFile = vi.fn(async (path: string) => ({
      path,
      text: "notes\n",
      isBinary: false,
      size: 6,
      truncated: false,
      readBytes: 6,
    }));
    setRuntime(portsOf({ diffFile, changedFiles: vi.fn(async () => []) }, { readFile }));

    await act(async () => {
      root.render(
        createElement(DiffPeek, {
          repo: "/repo",
          view: {
            kind: "file",
            row: { path: "scratch.md", origPath: null, code: "?", kind: "untracked" },
            changeSet: { kind: "history", scope: { kind: "fork", forkSha: "fork456" } },
          },
          version: 1,
          onSelect: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    await settle(() => rowTexts().length > 0);

    expect(diffFile).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledWith("/repo/scratch.md");
    expect(rowTexts()).toEqual(["notes"]);
  });

  it("says when a diff or a file was cut at the host's cap", async () => {
    // Both reads are capped host-side. What arrives is the head of the
    // content; presenting it as all of it is the lie this note prevents.
    const diffFile = vi.fn(async () => ({ text: TS_DIFF, truncated: true }));
    const readFile = vi.fn(async (path: string) => ({
      path,
      text: "first\nsecond\n",
      isBinary: false,
      size: 5_000_000,
      truncated: true,
      readBytes: 13,
    }));
    setRuntime(portsOf({ diffFile }, { readFile }));
    const note = () =>
      [...host.querySelectorAll(".peek__note")].map((n) => n.textContent).join(" | ");

    await drawRow(changedRow("src/main.ts"), 1, vi.fn());
    await settle(() => rowTexts().length > 0);
    expect(note()).toContain("Cut at the host's size limit");

    const untracked: ChangeRow = { path: "big.log", origPath: null, code: "?", kind: "untracked" };
    await drawRow(untracked, 1, vi.fn());
    await settle(() => rowTexts().length === 2);
    expect(note()).toContain("Cut at the host's size limit");
  });

  it("shows an unmerged file itself, markers included, instead of a combined diff", async () => {
    // `git diff` on an unmerged path prints a combined diff (`@@@ -1,3 -1,3
    // +1,7 @@@`, two marker columns) that the two-sided parser garbled: wrong
    // kinds, a stray `+` in the text, line numbers from 1. The row reads the
    // working file instead and says why.
    const diffFile = vi.fn(async () => diffOf(TS_DIFF));
    const readFile = vi.fn(async (path: string) => ({
      path,
      text: "a\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> side\nc\n",
      isBinary: false,
      size: 42,
      truncated: false,
      readBytes: 42,
    }));
    setRuntime(portsOf({ diffFile }, { readFile }));

    const row: ChangeRow = { path: "f.txt", origPath: null, code: "U", kind: "conflicted" };
    await act(async () => {
      root.render(
        createElement(DiffPeek, {
          repo: "/repo/",
          view: {
            kind: "file",
            row,
            changeSet: {
              kind: "worktree",
              groups: { ...railGroups([]), conflicted: [row], total: 1 },
              error: null,
            },
          },
          version: 1,
          onSelect: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    await settle(() => rowTexts().length > 0);

    expect(diffFile).not.toHaveBeenCalled();
    expect(readFile).toHaveBeenCalledWith("/repo/f.txt");
    expect(rowTexts()).toEqual([
      "a",
      "<<<<<<< HEAD",
      "ours",
      "=======",
      "theirs",
      ">>>>>>> side",
      "c",
    ]);
    expect(host.querySelector(".peek__note")?.textContent).toContain("Unmerged");
  });

  it("seeding a history scope's first file starts its diff in place", async () => {
    // The real path a History scope takes: it opens with no file, the rail
    // fetches the change set and hands back the first row, and GitTab fills it
    // in on the SAME mounted peek. Every other test stops at the hand-off.
    const diffFile = vi.fn(
      async (_repo: string, _path: string, range?: { from: string; to?: string }) => {
        void range;
        return diffOf(TS_DIFF);
      },
    );
    const changedFiles = vi.fn(async (_repo: string) => [
      { path: "src/main.ts", origPath: null, code: "M" },
    ]);
    setRuntime(portsOf({ diffFile, changedFiles }));

    await act(async () => {
      root.render(
        createElement(DiffPeek, {
          repo: "/repo",
          view: {
            kind: "waiting",
            scope: { kind: "commit", sha: "aaa1111", subject: "work" },
          },
          version: 1,
          onSelect: vi.fn(),
          onClose: vi.fn(),
        }),
      );
    });
    await act(async () => {});
    const body = present(host.querySelector<HTMLElement>(".peek__body"), "the .peek__body element");
    expect(diffFile).not.toHaveBeenCalled();

    await drawHistoryFile("src/main.ts", "aaa1111");

    // The blank body becomes a diff read across the scope's range, without
    // remounting — and the keys that scroll it are aimed at it.
    expect(diffFile.mock.calls.map((call) => call[2])).toEqual([
      { from: "aaa1111^", to: "aaa1111" },
    ]);
    expect(host.querySelector(".peek__body")).toBe(body);
    expect(document.activeElement).toBe(body);
  });

  it("the same commit in another worktree is another change set", async () => {
    // Two worktrees of one repo share shas, so the revision range alone does
    // not identify a file list — without the repo in the key the rail would
    // decide "same change set" and keep showing the first worktree's files,
    // then seed a foreign path from them.
    const diffFile = vi.fn(
      async (_repo: string, _path: string, _range?: unknown) => diffOf(TS_DIFF),
    );
    const changedFiles = vi.fn(async (_repo: string) => [
      { path: "src/main.ts", origPath: null, code: "M" },
    ]);
    setRuntime(portsOf({ diffFile, changedFiles }));

    await drawHistoryFile("src/main.ts", "aaa1111");
    await drawHistoryFile("src/main.ts", "aaa1111", "/wt/one");

    // Both the rail's list and the body's diff are re-read for the new root.
    expect(changedFiles.mock.calls.map((call) => call[0])).toEqual([
      "/repo",
      "/wt/one",
    ]);
    expect(diffFile.mock.calls.map((call) => call[0])).toEqual([
      "/repo",
      "/wt/one",
    ]);
  });
});
