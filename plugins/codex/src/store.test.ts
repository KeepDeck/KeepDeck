import { describe, expect, it } from "vitest";
import type { FsEntry } from "@keepdeck/plugin-api";
import {
  findRollout,
  findRolloutById,
  newestRollouts,
  rolloutName,
  walkRollouts,
  type StorePorts,
} from "./store";
import { present } from "@keepdeck/plugin-api/testing";

/** A store shaped like codex's: `YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl`. */
function storeOf(
  tree: Record<string, string[]>,
  unreadable: string[] = [],
  mtimes: Record<string, number> = {},
): StorePorts {
  const read = (path: string): FsEntry[] => {
    if (unreadable.includes(path)) throw new Error("EACCES");
    const dirs = Object.keys(tree)
      .filter((dir) => dir !== path && dir.startsWith(`${path}/`))
      .map((dir) => `${path}/${dir.slice(path.length + 1).split("/")[0]}`);
    return [
      ...new Set(dirs).values(),
    ]
      .map((dir): FsEntry => ({ kind: "dir", name: present(dir.split("/").pop(), "the last item"), path: dir }))
      .concat(
        (tree[path] ?? []).map((name): FsEntry => ({
          kind: "file",
          name,
          path: `${path}/${name}`,
          mtime: mtimes[name],
        })),
      );
  };
  return { services: { fs: { readDir: async (p) => read(p) } } };
}

const SID = "019f7683-d6f4-7b00-8e66-00c4694731be";
const ROOT = "~/.codex/sessions";
/** A reverted thread's new segment: `<thread>_<segment>`. */
const SEGMENT = "019f7700-0000-7000-8000-000000000001";

describe("rolloutName", () => {
  it("reads the session from either name codex gives a rollout, compressed or not", () => {
    expect(rolloutName(`rollout-2026-07-18T03-00-00-${SID}.jsonl`)).toEqual({
      sessionId: SID,
      rolloutId: SID,
      compressed: false,
    });
    expect(rolloutName(`rollout-2026-07-18T03-00-00-${SID}.jsonl.zst`)).toEqual({
      sessionId: SID,
      rolloutId: SID,
      compressed: true,
    });
    // The FIRST uuid is the thread — the session; the second names the
    // segment a revert started: the file's own id, which a fork's base names.
    expect(rolloutName(`rollout-2026-07-18T03-00-00-${SID}_${SEGMENT}.jsonl`)).toEqual({
      sessionId: SID,
      rolloutId: SEGMENT,
      compressed: false,
    });
    expect(rolloutName(`rollout-2026-07-18T03-00-00-${SID}_${SEGMENT}.jsonl.zst`)).toEqual({
      sessionId: SID,
      rolloutId: SEGMENT,
      compressed: true,
    });
  });

  it("is nothing for a name that is not a rollout", () => {
    for (const name of [
      `${SID}.jsonl`,
      `rollout-2026-07-18T03-00-00-${SID}.json`,
      `rollout-2026-07-18T03-00-00-${SID}.jsonl.gz`,
      "rollout-2026-07-18T03-00-00-other.jsonl",
      `rollout-2026-07-18T03-00-00-${SID}.jsonl.zst.tmp`,
    ]) {
      expect(rolloutName(name), name).toBeNull();
    }
  });
});

describe("walkRollouts", () => {
  const visited = async (ctx: StorePorts) => {
    const names: string[] = [];
    await walkRollouts(ctx, { file: (entry) => names.push(entry.name) });
    return names;
  };

  it("visits one file per segment: the plain one, while codex has both on disk", async () => {
    // Compressing, codex writes the .zst before it removes the plain file;
    // making it plain again, the reverse — and it reads the plain one.
    const plain = `rollout-2026-07-18T03-00-00-${SID}.jsonl`;
    const compressedOnly = `rollout-2026-07-10T03-00-00-${SEGMENT}.jsonl.zst`;
    const ctx = storeOf({
      [ROOT]: [],
      [`${ROOT}/2026`]: [],
      [`${ROOT}/2026/07`]: [],
      [`${ROOT}/2026/07/18`]: [plain, `${plain}.zst`],
      [`${ROOT}/2026/07/10`]: [compressedOnly],
    });
    expect(await visited(ctx)).toEqual([plain, compressedOnly]);
  });
});

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

  it("finds only the plain file a live pane writes — never a compressed one", async () => {
    // codex makes a compressed rollout plain before it appends, so the file
    // a pane is writing is never a .zst; one found only compressed is not
    // live yet, and the tail asks again.
    const ctx = storeOf({
      [ROOT]: [],
      [`${ROOT}/2026`]: [],
      [`${ROOT}/2026/07`]: [],
      [`${ROOT}/2026/07/17`]: [`rollout-2026-07-17T01-00-00-${SID}.jsonl`],
      [`${ROOT}/2026/07/18`]: [`rollout-2026-07-18T03-00-00-${SID}_${SEGMENT}.jsonl.zst`],
    });
    await expect(findRollout(ctx, SID)).resolves.toBe(
      `${ROOT}/2026/07/17/rollout-2026-07-17T01-00-00-${SID}.jsonl`,
    );
    const onlyCompressed = storeOf({
      [ROOT]: [],
      [`${ROOT}/2026`]: [],
      [`${ROOT}/2026/07`]: [],
      [`${ROOT}/2026/07/18`]: [`rollout-2026-07-18T03-00-00-${SID}.jsonl.zst`],
    });
    await expect(findRollout(onlyCompressed, SID)).resolves.toBeNull();
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

describe("findRolloutById", () => {
  it("finds a fork's source by its rollout id — a segment's own id — in the store, then the archive", async () => {
    const ARCHIVED = "019f6000-0000-7000-8000-00000000000c";
    const ctx = storeOf({
      [ROOT]: [],
      [`${ROOT}/2026`]: [],
      [`${ROOT}/2026/07`]: [],
      [`${ROOT}/2026/07/18`]: [`rollout-2026-07-18T03-00-00-${SID}_${SEGMENT}.jsonl`],
      "~/.codex/archived_sessions": [],
      "~/.codex/archived_sessions/2026": [],
      "~/.codex/archived_sessions/2026/06": [],
      "~/.codex/archived_sessions/2026/06/01": [`rollout-2026-06-01T03-00-00-${ARCHIVED}.jsonl.zst`],
    });
    await expect(findRolloutById(ctx, SEGMENT)).resolves.toBe(
      `${ROOT}/2026/07/18/rollout-2026-07-18T03-00-00-${SID}_${SEGMENT}.jsonl`,
    );
    // The thread's id is not the segment's: nothing names the file by it.
    await expect(findRolloutById(ctx, SID)).resolves.toBeNull();
    await expect(findRolloutById(ctx, ARCHIVED)).resolves.toBe(
      `~/.codex/archived_sessions/2026/06/01/rollout-2026-06-01T03-00-00-${ARCHIVED}.jsonl.zst`,
    );
  });

  it("is nothing without an archive to look in", async () => {
    const ctx = storeOf({ [ROOT]: [] });
    await expect(findRolloutById(ctx, SID)).resolves.toBeNull();
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
          // Compressed: a week old at least, and not text to read limits from.
          `rollout-2026-07-18T09-00-00-${SEGMENT}.jsonl.zst`,
        ],
      },
      [],
      {
        [`rollout-2026-07-17T01-00-00-${SID}.jsonl`]: 1_000,
        [`rollout-2026-07-18T02-00-00-${OTHER}.jsonl`]: 2_000,
        [`rollout-2026-07-18T09-00-00-${SEGMENT}.jsonl.zst`]: 3_000,
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
