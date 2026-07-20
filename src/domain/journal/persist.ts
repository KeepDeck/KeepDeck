import { isRecord } from "../json";
import type { JournalEvent, SessionRecord, SessionRecordBase } from "./sessionLog";

/**
 * The `journal.jsonl` line codec. One event per line; each line carries its
 * own `v`, so events version independently — a build that meets a line it
 * doesn't understand skips it instead of quarantining the file (the log's
 * failure mode is per-line, not all-or-nothing like a JSON document).
 */

export function encodeJournalEvent(event: JournalEvent): string {
  return JSON.stringify(event);
}

export interface DecodedJournal {
  events: JournalEvent[];
  /** Unparseable/torn lines — noise a compaction may clean away. */
  garbage: number;
  /** Well-formed lines this build doesn't understand (a newer build's event
   * kind or version). Their data would be LOST by a compaction rewrite, so
   * any foreign line vetoes compaction. */
  foreign: number;
}

/** Decode loaded lines defensively: fold what this build understands, count
 * the rest by failure kind. Never throws. */
export function decodeJournalLines(lines: string[]): DecodedJournal {
  const events: JournalEvent[] = [];
  let garbage = 0;
  let foreign = 0;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      garbage++;
      continue;
    }
    const event = readJournalEvent(parsed);
    if (event === null) garbage++;
    else if (event === "foreign") foreign++;
    else events.push(event);
  }
  return { events, garbage, foreign };
}

function readJournalEvent(value: unknown): JournalEvent | "foreign" | null {
  if (!isRecord(value)) return null;
  const { e, v, wsId } = value;
  if (typeof e !== "string" || typeof v !== "number") return null;
  if (typeof wsId !== "string" || wsId === "") return null;
  const known = e === "bound" || e === "sealed" || e === "deleted" ||
    e === "wsDeleted" || e === "record";
  if (!known || v !== 1) return "foreign";
  switch (e) {
    case "bound": {
      const record = readRecordBase(value.record);
      if (!record) return null;
      const paneId = (value.record as Record<string, unknown>).paneId;
      if (typeof paneId !== "string") return null;
      return { e, v: 1, wsId, record: { ...record, paneId } };
    }
    case "sealed": {
      if (typeof value.sessionId !== "string" || typeof value.at !== "string")
        return null;
      return {
        e,
        v: 1,
        wsId,
        sessionId: value.sessionId,
        ...(typeof value.title === "string" && { title: value.title }),
        at: value.at,
      };
    }
    case "deleted": {
      if (typeof value.sessionId !== "string" || typeof value.at !== "string")
        return null;
      return { e, v: 1, wsId, sessionId: value.sessionId, at: value.at };
    }
    case "wsDeleted": {
      if (typeof value.at !== "string") return null;
      return { e, v: 1, wsId, at: value.at };
    }
    case "record": {
      const record = readSessionRecord(value.record);
      return record ? { e, v: 1, wsId, record } : null;
    }
  }
}

function readRecordBase(value: unknown): SessionRecordBase | null {
  if (!isRecord(value)) return null;
  const { agent, sessionId, cwd, boundAt } = value;
  if (
    typeof agent !== "string" ||
    typeof sessionId !== "string" ||
    sessionId === "" ||
    typeof cwd !== "string" ||
    typeof boundAt !== "string"
  ) {
    return null;
  }
  return {
    agent,
    sessionId,
    cwd,
    boundAt,
    ...(typeof value.branch === "string" && { branch: value.branch }),
    ...(value.yolo === true && { yolo: true }),
    ...(typeof value.title === "string" && { title: value.title }),
    ...(typeof value.transcriptPath === "string" && {
      transcriptPath: value.transcriptPath,
    }),
  };
}

function readSessionRecord(value: unknown): SessionRecord | null {
  const base = readRecordBase(value);
  if (!base || !isRecord(value)) return null;
  if (value.state === "live" && typeof value.paneId === "string") {
    return { ...base, state: "live", paneId: value.paneId };
  }
  if (value.state === "closed" && typeof value.endedAt === "string") {
    return { ...base, state: "closed", endedAt: value.endedAt };
  }
  return null;
}

/** Lines beyond which a garbage/superseded-heavy log is rewritten at boot. */
const COMPACT_MIN_LINES = 256;
/** How many no-longer-contributing lines the log may carry before compaction
 * pays for itself. */
const COMPACT_SLACK = 512;

/** Whether a boot-time compaction rewrite is worth it: the log is long AND
 * mostly lines that no longer contribute to the fold. Any foreign line vetoes
 * — a rewrite would drop a newer build's data. */
export function shouldCompactJournal(
  lineCount: number,
  recordCount: number,
  foreign: number,
): boolean {
  if (foreign > 0) return false;
  if (lineCount < COMPACT_MIN_LINES) return false;
  return lineCount - recordCount > COMPACT_SLACK;
}
