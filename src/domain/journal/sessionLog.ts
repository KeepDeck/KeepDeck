import type { AgentType } from "../agents";

/**
 * The workspace session journal: which agent sessions ran in each workspace,
 * surviving pane close so they can be listed, resumed and forked later.
 *
 * The journal is bookkeeping over reporter-delivered identity — it records
 * only sessions the pane's own agent process reported ([F7]/[F8] bindings)
 * and is NEVER the revive source (that stays `Pane.session`). State lives as
 * a fold of [`JournalEvent`]s; the same events are appended verbatim to
 * `journal.jsonl` (one JSON line each), so load = fold, save = append.
 */

export interface SessionRecordBase {
  agent: AgentType;
  sessionId: string;
  /** The directory the session ran in (the pane's execution cwd at bind
   * time) — where a resume must happen for cwd-bound agents. */
  cwd: string;
  /** The pane's owned worktree branch, when it ran in one. */
  branch?: string;
  /** The pane ran with permission prompts disabled — a resume must too. */
  yolo?: boolean;
  /** Human name for the row: the pane's display title, frozen when the
   * record seals. Absent when the pane never got one. */
  title?: string;
  /** The session's transcript/rollout file when the reporter delivered it. */
  transcriptPath?: string;
  /** ISO instant of the (latest) binding. */
  boundAt: string;
}

/** Live-vs-closed is a state, not parallel optional fields: a `live` record
 * tracks the pane still running the session; a `closed` one is history. */
export type SessionRecord =
  | (SessionRecordBase & { state: "live"; paneId: string })
  | (SessionRecordBase & { state: "closed"; endedAt: string });

/** Journal records per workspace id. Within one workspace, `sessionId` is the
 * record key — a rebind of the same session upserts its record. */
export type JournalRecords = Record<string, SessionRecord[]>;

/**
 * One journal event — both the reducer's state-transition input and the
 * persisted `journal.jsonl` line (`v` versions each line independently).
 */
export type JournalEvent =
  | {
      e: "bound";
      v: 1;
      wsId: string;
      record: SessionRecordBase & { paneId: string };
    }
  | { e: "sealed"; v: 1; wsId: string; sessionId: string; title?: string; at: string }
  | { e: "deleted"; v: 1; wsId: string; sessionId: string; at: string }
  | { e: "wsDeleted"; v: 1; wsId: string; at: string };

/**
 * The journal slice of deck state: the folded records plus the outbox —
 * events applied to `records` but not yet appended to `journal.jsonl`. The
 * persistence hook drains `tail` in order and trims it via [`flushJournalTail`].
 */
export interface JournalSlice {
  records: JournalRecords;
  tail: JournalEvent[];
}

export const emptyJournal: JournalSlice = { records: {}, tail: [] };

/** One fold step. Unknown workspaces/sessions no-op (events can outlive their
 * subjects); an event that changes nothing returns the SAME records ref, so
 * reducer transitions stay no-op-transparent. */
export function applyJournalEvent(
  records: JournalRecords,
  event: JournalEvent,
): JournalRecords {
  switch (event.e) {
    case "bound": {
      const list = records[event.wsId] ?? [];
      const idx = list.findIndex((r) => r.sessionId === event.record.sessionId);
      const prior = idx >= 0 ? list[idx] : undefined;
      const next: SessionRecord = {
        ...event.record,
        // A re-bound record keeps the title its last seal froze until the
        // next seal freezes a fresher one.
        title: event.record.title ?? prior?.title,
        state: "live",
      };
      if (prior && recordsEqual(prior, next)) return records;
      const nextList = idx >= 0 ? replaceAt(list, idx, next) : [...list, next];
      return { ...records, [event.wsId]: nextList };
    }
    case "sealed": {
      const list = records[event.wsId];
      const idx = list?.findIndex((r) => r.sessionId === event.sessionId) ?? -1;
      if (!list || idx < 0) return records;
      const prior = list[idx];
      const { paneId: _pane, ...base } =
        prior.state === "live" ? prior : { ...prior, paneId: "" };
      const next: SessionRecord = {
        ...base,
        title: event.title ?? prior.title,
        state: "closed",
        endedAt: event.at,
      };
      if (recordsEqual(prior, next)) return records;
      return { ...records, [event.wsId]: replaceAt(list, idx, next) };
    }
    case "deleted": {
      const list = records[event.wsId];
      if (!list?.some((r) => r.sessionId === event.sessionId)) return records;
      const nextList = list.filter((r) => r.sessionId !== event.sessionId);
      if (nextList.length === 0) {
        const { [event.wsId]: _gone, ...rest } = records;
        return rest;
      }
      return { ...records, [event.wsId]: nextList };
    }
    case "wsDeleted": {
      if (!(event.wsId in records)) return records;
      const { [event.wsId]: _gone, ...rest } = records;
      return rest;
    }
  }
}

/** Immutable single-slot replacement (ES2020 target — no `Array.with`). */
function replaceAt(
  list: SessionRecord[],
  idx: number,
  value: SessionRecord,
): SessionRecord[] {
  const next = list.slice();
  next[idx] = value;
  return next;
}

function recordsEqual(a: SessionRecord, b: SessionRecord): boolean {
  return (
    a.state === b.state &&
    a.sessionId === b.sessionId &&
    a.cwd === b.cwd &&
    a.agent === b.agent &&
    a.branch === b.branch &&
    a.yolo === b.yolo &&
    a.title === b.title &&
    a.transcriptPath === b.transcriptPath &&
    a.boundAt === b.boundAt &&
    (a.state === "live" ? a.paneId === (b as { paneId: string }).paneId : true) &&
    (a.state === "closed"
      ? a.endedAt === (b as { endedAt: string }).endedAt
      : true)
  );
}

/** Apply an event to the slice: records fold + the event queued for append.
 * A no-op event (nothing changed) queues nothing and returns the SAME slice. */
export function withJournalEvent(
  journal: JournalSlice,
  event: JournalEvent,
): JournalSlice {
  const records = applyJournalEvent(journal.records, event);
  if (records === journal.records) return journal;
  return { records, tail: [...journal.tail, event] };
}

/** Fold a loaded event sequence (journal.jsonl) into records. */
export function foldJournal(events: JournalEvent[]): JournalRecords {
  let records: JournalRecords = {};
  for (const event of events) records = applyJournalEvent(records, event);
  return records;
}

/** The persistence hook appended the first `count` tail events to disk. */
export function flushJournalTail(
  journal: JournalSlice,
  count: number,
): JournalSlice {
  if (count <= 0) return journal;
  return { records: journal.records, tail: journal.tail.slice(count) };
}

/**
 * Fold the loaded journal into the slice at boot. Runs AFTER the deck itself
 * hydrated, so `liveWsIds` is authoritative:
 * - a loaded workspace key with no live workspace is pruned (`wsDeleted`
 *   queued — `ws-N` ids are reused slots, so a stale key would leak history
 *   into an unrelated future workspace);
 * - loaded `live` records demote to `closed` (their processes died with the
 *   previous app run; a revived pane re-binding the same session flips its
 *   record back to live) — each demotion queues its `sealed` event so the
 *   file converges and the next boot folds them as closed already;
 * - records bound in THIS run before the load resolved win over their loaded
 *   versions.
 */
export function hydrateJournalSlice(
  current: JournalSlice,
  loaded: JournalRecords,
  liveWsIds: ReadonlySet<string>,
  at: string,
): JournalSlice {
  const events: JournalEvent[] = [];
  const records: JournalRecords = {};
  for (const [wsId, list] of Object.entries(loaded)) {
    if (!liveWsIds.has(wsId)) {
      events.push({ e: "wsDeleted", v: 1, wsId, at });
      continue;
    }
    records[wsId] = list.map((r) => {
      if (r.state !== "live") return r;
      events.push({ e: "sealed", v: 1, wsId, sessionId: r.sessionId, at });
      const { paneId: _pane, ...base } = r;
      return { ...base, state: "closed", endedAt: at };
    });
  }
  // Records from this run's own bindings overlay the loaded history.
  let merged = records;
  for (const [wsId, list] of Object.entries(current.records)) {
    for (const record of list) {
      const existing = merged[wsId] ?? [];
      const idx = existing.findIndex((r) => r.sessionId === record.sessionId);
      merged = {
        ...merged,
        [wsId]: idx >= 0 ? replaceAt(existing, idx, record) : [...existing, record],
      };
    }
  }
  return { records: merged, tail: [...current.tail, ...events] };
}

/** A workspace's records, newest binding first — the history list's order. */
export function journalRows(
  records: JournalRecords,
  wsId: string,
): SessionRecord[] {
  const list = records[wsId] ?? [];
  return [...list].sort((a, b) => (a.boundAt < b.boundAt ? 1 : -1));
}
