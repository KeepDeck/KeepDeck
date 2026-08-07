import type { UsageWindow } from "./usage";
import { HOUR_MS, DAY_MS } from "./time";

/**
 * The provider-report journal — the forecast's data. Every accepted account
 * report appends one record per window, so pace can be computed from
 * history instead of a single snapshot. Records are keyed by the window's
 * IDENTITY (agent + length + scope) and segmented by window INSTANCE: a
 * pace must never be computed across a reset.
 */

export interface WindowReport {
  agent: string;
  /** The window's identity within the agent — length and scope verbatim;
   * null length is a real value (plan/quota windows). */
  windowMinutes: number | null;
  scope?: string;
  usedPct: number;
  reportedAt: number;
  resetsAt: number | null;
  /** Disambiguates same-tuple windows within one account report (codex's
   * duration-less pair); present only when the tuple is duplicated. */
  ordinal?: number;
}

/** One journal key per window identity. The (length, scope) tuple alone is
 * NOT unique — codex reports several duration-less account windows — so
 * keys are minted for a whole account report at once: duplicates gain an
 * ordinal by report order, unique tuples keep the bare key (existing
 * journals stay valid). THE one composer of the tuple; row ids build on it. */
export function windowReportKey(
  agent: string,
  window: Pick<UsageWindow, "windowMinutes" | "scope">,
): string {
  return `${agent}\0${window.windowMinutes ?? "?"}\0${window.scope ?? ""}`;
}

/** Keys for every window of one account report, by object identity — the
 * writer and both read surfaces must derive keys from the SAME window list
 * (an account's own report order), never from a re-sorted view. Assumes
 * each element is a distinct object — every producer builds fresh window
 * literals; an aliased element would collapse onto one key. */
export interface AccountWindowKey {
  key: string;
  /** Ordinal among same-tuple windows of this report, ALWAYS minted — a
   * conditional ordinal reset a window's history whenever its tuple's
   * duplicate count changed. Positional by nature: identity survives any
   * change that keeps the surviving windows' order a stable prefix. */
  ordinal: number;
}

export function accountWindowKeys(
  agent: string,
  windows: readonly UsageWindow[],
): Map<UsageWindow, AccountWindowKey> {
  const seen = new Map<string, number>();
  const keys = new Map<UsageWindow, AccountWindowKey>();
  for (const window of windows) {
    const base = windowReportKey(agent, window);
    const ordinal = seen.get(base) ?? 0;
    seen.set(base, ordinal + 1);
    keys.set(window, { key: `${base}\0${ordinal}`, ordinal });
  }
  return keys;
}

/** The key a STORED record files under — the same rule accountWindowKeys
 * minted at write time, reconstructed from the record alone (records
 * written before ordinals existed file as ordinal 0). */
export function storedReportKey(report: WindowReport): string {
  return `${windowReportKey(report.agent, report)}\0${report.ordinal ?? 0}`;
}

/** A frozen empty series — the shared fallback for surfaces whose journal
 * has nothing for a key (stable identity, memo-safe). */
export const NO_REPORTS: readonly WindowReport[] = [];

/** Records worth writing: a change in usage or reset instant, or a slow
 * heartbeat so "the pace is ~zero" stays a fresh fact, not a stale guess.
 * Everything else is statusline chatter. */
export const HEARTBEAT_MS = 5 * 60_000;

export function shouldRecord(
  last: WindowReport | undefined,
  next: WindowReport,
): boolean {
  if (!last) return true;
  if (next.reportedAt <= last.reportedAt) return false;
  if (Math.abs(next.usedPct - last.usedPct) >= 0.1) return true;
  if ((next.resetsAt ?? null) !== (last.resetsAt ?? null)) return true;
  return next.reportedAt - last.reportedAt >= HEARTBEAT_MS;
}

/** Forward reset movement beyond this is a NEW window instance; anything
 * smaller is reporting jitter. Shared by the journal's segmentation and
 * the exhaustion alarm's re-arm rule, so "same instance" can never fork. */
export const INSTANCE_JUMP_MS = 60_000;

/**
 * The current segment: everything since the last instance boundary — the only
 * span a pace may be computed over.
 *
 * A window instance IS its reset instant, so that is what says the window
 * turned over. A drop in `usedPct` used to say it too, and that was wrong in
 * a way that inverted the verdict: the reporter sends whole percents, one
 * spurious low reading lands between two honest ones with the reset instant
 * UNCHANGED, and the segment restarted at the outlier. The climb back to the
 * true level then read as burn. Measured on a real journal — a lone `8`
 * between two `19`s — the pace came out 1.42 %/min against an actual
 * 0.16 %/min, and a window with three and a half hours of headroom was
 * announced as running out in forty minutes.
 *
 * Failure direction, deliberately: if a provider reports a genuine reset but
 * lags its `resetsAt`, the boundary is missed and the pace across the drop
 * goes negative — which `windowForecast` treats as a journal contradicting
 * itself and refuses to project from, rather than dressing up as an answer.
 */
/**
 * THE instance-boundary rule, in one place — did the window turn over between
 * these two readings?
 *
 * `dropPct` is the only dial: how deep a fall counts as a refill when there is
 * no reset instant to go by. The journal wants every dip it can see (1pp); the
 * exhaustion alarm wants a coarser one (5pp) because it compares across panes,
 * where small corrections are ordinary. That difference is REAL, so it is a
 * parameter — and making it a parameter is what keeps the rule itself from
 * being written twice and drifting, which is exactly what had happened.
 */
export function instanceChanged(
  prev: Pick<WindowReport, "usedPct" | "resetsAt">,
  next: Pick<WindowReport, "usedPct" | "resetsAt">,
  dropPct: number,
): boolean {
  const knownReset = prev.resetsAt !== null && next.resetsAt !== null;
  if (knownReset) {
    // Both sides know when they end, so the reset instant answers it outright
    // and a fall is noise. Forward movement only: a reset that appears to move
    // BACKWARD is a correction, not a turnover.
    return next.resetsAt! > prev.resetsAt! + INSTANCE_JUMP_MS;
  }
  // No reset instant on one side — the fall is the only evidence there is.
  return next.usedPct < prev.usedPct - dropPct;
}

/** The journal's own dip tolerance: the reporters send whole percents, so a
 * single point of wobble is quantisation, not a refill. */
export const SEGMENT_DROP_PCT = 1;

export function currentSegment(
  reports: readonly WindowReport[],
): WindowReport[] {
  let start = 0;
  for (let index = 1; index < reports.length; index += 1) {
    if (instanceChanged(reports[index - 1], reports[index], SEGMENT_DROP_PCT)) {
      start = index;
    }
  }
  return reports.slice(start);
}

/** Retention per key: about 1.5 window lengths (a full instance plus room
 * for the previous one), clamped so plan windows and month windows stay
 * bounded. Entry cap is a backstop against a chattering reporter. */
const REPORTS_ENTRY_CAP = 4_000;

function reportKeepMs(windowMinutes: number | null): number {
  if (windowMinutes === null) return 7 * DAY_MS;
  const span = windowMinutes * 60_000 * 1.5;
  return Math.min(Math.max(span, 6 * HOUR_MS), 45 * DAY_MS);
}

/** True while a record is inside its own retention horizon (and not
 * future-stamped) — the writer refuses dead-on-arrival records with it,
 * and pruneReports drops what ages past it. */
export function reportAlive(report: WindowReport, now: number): boolean {
  return (
    now - report.reportedAt <= reportKeepMs(report.windowMinutes) &&
    report.reportedAt - now <= 60_000
  );
}

export function pruneReports(
  reports: readonly WindowReport[],
  now: number,
): WindowReport[] {
  // reportAlive also heals future-stamped records (clock skew before the
  // writer's clamp existed, or a hand-edited file): one would block every
  // later write via the replay guard forever.
  const kept = reports.filter((report) => reportAlive(report, now));
  return kept.slice(Math.max(0, kept.length - REPORTS_ENTRY_CAP));
}

/* ---- wire codec: one JSON line per record, tolerant on read ----------- */

export function encodeWindowReport(report: WindowReport): string {
  return JSON.stringify(report);
}

export function decodeWindowReport(line: string): WindowReport | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.agent !== "string" || raw.agent === "") return null;
  if (typeof raw.usedPct !== "number" || !Number.isFinite(raw.usedPct)) {
    return null;
  }
  if (
    typeof raw.reportedAt !== "number" ||
    !Number.isFinite(raw.reportedAt) ||
    raw.reportedAt <= 0
  ) {
    return null;
  }
  const windowMinutes =
    typeof raw.windowMinutes === "number" && Number.isFinite(raw.windowMinutes)
      ? raw.windowMinutes
      : null;
  const resetsAt =
    typeof raw.resetsAt === "number" && Number.isFinite(raw.resetsAt)
      ? raw.resetsAt
      : null;
  return {
    agent: raw.agent,
    windowMinutes,
    ...(typeof raw.scope === "string" && raw.scope !== ""
      ? { scope: raw.scope }
      : {}),
    usedPct: Math.min(100, Math.max(0, raw.usedPct)),
    reportedAt: raw.reportedAt,
    resetsAt,
    ...(typeof raw.ordinal === "number" &&
    Number.isInteger(raw.ordinal) &&
    raw.ordinal >= 0
      ? { ordinal: raw.ordinal }
      : {}),
  };
}
