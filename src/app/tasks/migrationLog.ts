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
  return outcome.moved.map((board) => ({
    level: board.attached ? "info" : "warn",
    text: board.attached
      ? `board of ${board.workspace} moved into the task database${board.adapted ? ", adapted from an older shape" : ""}`
      : `board of ${board.workspace} moved into the task database UNATTACHED — the deck has no such workspace; kept, shown nowhere`,
  }));
}

export function logMigration(outcome: MigrationOutcome): void {
  for (const line of migrationLines(outcome)) log[line.level]("web:tasks", line.text);
}
