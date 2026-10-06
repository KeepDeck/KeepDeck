/**
 * The move of the boards into the task database, in the log — said once
 * per enable, board by board: what moved, what was adapted from an older
 * or hand-edited shape, what was kept unattached because its workspace is
 * gone from the deck, and why nothing moved when it could not.
 */
import { log } from "../../ipc/log";
import type { MigrationOutcome } from "./migration";

export function migrationLines(outcome: MigrationOutcome): { level: "info" | "warn"; text: string }[] {
  if (outcome.kind === "failed") {
    return [{ level: "warn", text: `the boards stay in their files, read-only: ${outcome.reason}` }];
  }
  if (outcome.kind === "unusable") {
    return [{ level: "warn", text: `the task database cannot be used (${outcome.status.kind}) — the boards are read-only` }];
  }
  const lines: { level: "info" | "warn"; text: string }[] = [];
  if (outcome.retireError !== null) {
    lines.push({ level: "warn", text: `the board files left could not all become copies (tried again at the next enable): ${outcome.retireError}` });
  }
  for (const board of outcome.moved) {
    for (const { id, blockers } of board.dropped) {
      lines.push({ level: "warn", text: `board of ${board.workspace}: ${id}'s blockers ${blockers.join(", ")} held nothing (itself, or not on the board) — let go` });
    }
    lines.push({
      level: board.attached ? "info" : "warn",
      text: board.attached
        ? `board of ${board.workspace} moved into the task database${board.adapted ? ", adapted from an older shape" : ""}`
        : `board of ${board.workspace} moved into the task database UNATTACHED — the deck has no such workspace; kept, shown nowhere`,
    });
  }
  return lines;
}

export function logMigration(outcome: MigrationOutcome): void {
  for (const line of migrationLines(outcome)) log[line.level]("web:tasks", line.text);
}
