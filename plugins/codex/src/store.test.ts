import { describe, expect, it } from "vitest";
import type { PluginContext } from "@keepdeck/plugin-api";
import { findRollout } from "./store";

/** A store shaped like codex's: `YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl`. */
function storeOf(tree: Record<string, string[]>, unreadable: string[] = []) {
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
