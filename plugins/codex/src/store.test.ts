import { describe, expect, it } from "vitest";
import type { PluginContext } from "@keepdeck/plugin-api";
import { findRollout, newestRollouts } from "./store";

/** A store shaped like codex's: `YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl`. */
function storeOf(
  tree: Record<string, string[]>,
  unreadable: string[] = [],
  mtimes: Record<string, number> = {},
) {
  const read = (path: string) => {
    if (unreadable.includes(path)) throw new Error("EACCES");
    const dirs = Object.keys(tree)
      .filter((dir) => dir !== path && dir.startsWith(`${path}/`))
      .map((dir) => `${path}/${dir.slice(path.length + 1).split("/")[0]}`);
    return [
      ...new Set(dirs).values(),
    ]
      .map((dir) => ({ kind: "dir" as const, name: dir.split("/").pop()!, path: dir }))
      .concat(
        (tree[path] ?? []).map((name) => ({
          kind: "file" as const,
          name,
          path: `${path}/${name}`,
          mtime: mtimes[name],
        })) as never[],
      );
  };
  return { services: { fs: { readDir: async (p: string) => read(p) } } } as
    unknown as PluginContext;
}

const SID = "019f7683-d6f4-7b00-8e66-00c4694731be";
const ROOT = "~/.codex/sessions";

describe("findRollout", () => {
  it("walks the day tree and prefers the NEWEST match", () => {
    // A resumed session can leave an older file carrying the same id behind.
    // Day partitions sort lexically, so walking them in reverse reaches
    // today before last month — and today is the file still being written.
    const ctx = storeOf({
      [ROOT]: [],
      [`${ROOT}/2026`]: [],
      [`${ROOT}/2026/07`]: [],
      [`${ROOT}/2026/07/17`]: [`rollout-2026-07-17T01-00-00-${SID}.jsonl`],
      [`${ROOT}/2026/07/18`]: [
        "rollout-2026-07-18T02-00-00-other.jsonl",
        `rollout-2026-07-18T03-00-00-${SID}.jsonl`,
      ],
    });
    return expect(findRollout(ctx, SID)).resolves.toBe(
      `${ROOT}/2026/07/18/rollout-2026-07-18T03-00-00-${SID}.jsonl`,
    );
  });

  it("answers null for a session that has written nothing yet", async () => {
    // Ordinary rather than an error: codex writes the rollout when the first
    // turn lands, so a pane that has reported its id but not worked has no
    // file, and the caller simply asks again later.
    const ctx = storeOf({
      [ROOT]: [],
      [`${ROOT}/2026`]: [],
      [`${ROOT}/2026/07`]: [],
      [`${ROOT}/2026/07/18`]: ["rollout-2026-07-18T02-00-00-other.jsonl"],
    });
    await expect(findRollout(ctx, SID)).resolves.toBeNull();
  });

  it("keeps searching past a partition it cannot read", async () => {
    // The store spans years of directories, and one unreadable day must not
    // hide today's file — a skipped subtree is not an answer about the
    // session.
    const ctx = storeOf(
      {
        [ROOT]: [],
        [`${ROOT}/2026`]: [],
        [`${ROOT}/2026/07`]: [],
        [`${ROOT}/2026/07/17`]: [`rollout-2026-07-17T01-00-00-${SID}.jsonl`],
        [`${ROOT}/2026/07/18`]: [],
      },
      [`${ROOT}/2026/07/18`],
    );
    await expect(findRollout(ctx, SID)).resolves.toBe(
      `${ROOT}/2026/07/17/rollout-2026-07-17T01-00-00-${SID}.jsonl`,
    );
  });

  it("matches on the id, not on a name that merely contains it", async () => {
    // The filename pattern ends at the uuid, so a longer suffix is a
    // different file — one session's tail must not follow another's store.
    const ctx = storeOf({
      [ROOT]: [],
      [`${ROOT}/2026`]: [],
      [`${ROOT}/2026/07`]: [],
      [`${ROOT}/2026/07/18`]: [`rollout-2026-07-18T02-00-00-${SID}-copy.jsonl`],
    });
    await expect(findRollout(ctx, SID)).resolves.toBeNull();
  });
});

describe("newestRollouts", () => {
  const OTHER = "019f7683-d6f4-7b00-8e66-00c4694731bf";

  it("answers newest-first, across day partitions, up to the limit", async () => {
    // The boot catch-up's candidates. A just-launched session writes its
    // rollout before its first turn, so the newest file often carries no
    // limits and the account's real last word is one or two files back —
    // which is why this hands back a LIST rather than an answer.
    const ctx = storeOf(
      {
        [ROOT]: [],
        [`${ROOT}/2026`]: [],
        [`${ROOT}/2026/07`]: [],
        [`${ROOT}/2026/07/17`]: [`rollout-2026-07-17T01-00-00-${SID}.jsonl`],
        [`${ROOT}/2026/07/18`]: [
          `rollout-2026-07-18T02-00-00-${OTHER}.jsonl`,
          "notes.jsonl",
        ],
      },
      [],
      {
        [`rollout-2026-07-17T01-00-00-${SID}.jsonl`]: 1_000,
        [`rollout-2026-07-18T02-00-00-${OTHER}.jsonl`]: 2_000,
      },
    );

    await expect(newestRollouts(ctx, 10)).resolves.toEqual([
      // Ordered by the FILE's age, not by the partition it sits in: a
      // resumed session appends to an older day's file.
      `${ROOT}/2026/07/18/rollout-2026-07-18T02-00-00-${OTHER}.jsonl`,
      `${ROOT}/2026/07/17/rollout-2026-07-17T01-00-00-${SID}.jsonl`,
    ]);
    // A sibling that is not a rollout is not a session.
    await expect(newestRollouts(ctx, 1)).resolves.toEqual([
      `${ROOT}/2026/07/18/rollout-2026-07-18T02-00-00-${OTHER}.jsonl`,
    ]);
  });

  it("stops descending once it has enough, and survives an unreadable day", async () => {
    // An account with years of history must cost what a week's does.
    const days: Record<string, string[]> = {
      [ROOT]: [],
      [`${ROOT}/2026`]: [],
      [`${ROOT}/2026/07`]: [],
    };
    const mtimes: Record<string, number> = {};
    for (let day = 10; day <= 20; day++) {
      const name = `rollout-2026-07-${day}T01-00-00-${SID}.jsonl`;
      days[`${ROOT}/2026/07/${day}`] = [name];
      mtimes[name] = day;
    }
    const ctx = storeOf(days, [`${ROOT}/2026/07/20`], mtimes);

    const found = await newestRollouts(ctx, 2);
    expect(found).toHaveLength(2);
    // Day 20 is unreadable and simply contributes nothing; the walk goes on.
    expect(found[0]).toContain("2026-07-19");
    expect(found[1]).toContain("2026-07-18");
  });
});
