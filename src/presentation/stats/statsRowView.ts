import { modelLabel } from "../../domain/usage";
import type { UsageStatsRow } from "../../domain/usage/history/query";

/** Which drill-down a table shows: one row per model, or per session. */
export type StatsTableMode = "model" | "session";

/** What a Models/Sessions row is called: its name in bold, and the line
 * under it saying where it comes from. */
export interface StatsRowIdentity {
  name: string;
  detail: string;
}

/** A session id short enough for a table cell: an id longer than twelve
 * characters keeps its first eight and an ellipsis, a short one stays whole,
 * and a missing one says so. */
export function shortSession(sessionId: string | undefined): string {
  if (!sessionId) return "Unknown session";
  return sessionId.length > 12 ? `${sessionId.slice(0, 8)}…` : sessionId;
}

/**
 * A row's identity in the mode its table shows:
 * - a model row is named by the model (the catalogue's name, else its key)
 *   and says which agent ran it;
 * - a session row is named by its pane, else its session, and says where it
 *   ran, by which agent, in which session — leaving out what it does not
 *   know.
 */
export function statsRowIdentity(row: UsageStatsRow, mode: StatsTableMode): StatsRowIdentity {
  if (mode === "model") {
    return { name: modelLabel(row.model, row.modelName), detail: row.agent };
  }
  return {
    name: row.paneName || shortSession(row.sessionId),
    detail: [row.workspaceName, row.agent, shortSession(row.sessionId)].filter(Boolean).join(" · "),
  };
}
