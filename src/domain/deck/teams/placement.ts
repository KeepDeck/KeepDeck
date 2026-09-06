/**
 * A team's placement on disk, and the recorded directory a session names.
 *
 * The model holds ONE location ([`TeamLocation`]); the document holds the
 * three fields it replaced (`cwd`, `branch`, `provisioning`) — the same
 * three a pane once carried, now written on its team. This module is both
 * halves of that: the fold the persistence boundary applies on the way in —
 * where a combination the fields allow but the meaning does not is settled
 * by one written rule, rather than by whichever consumer happened to look
 * first — and the unfold on the way out.
 */
import type { WorktreeIntent } from "../panes/model";
import type { TeamLocation } from "./model";

/** The three fields a document carries in place of a team's location. The
 * `provisioning` slot is the create's intent alone: a card's status — the
 * error it shows, the fork it came from — is runtime and never reaches
 * disk. */
export interface PlacementFields {
  cwd?: string;
  branch?: string;
  provisioning?: WorktreeIntent;
}

/**
 * Fold a document's placement fields into a location.
 *
 * The rule, in order of precedence:
 *
 *  1. A `cwd` makes the team attached. A provisioning card beside it is
 *     dropped: the resolve transition writes the directory and removes the
 *     card in one step, so the pair only ever reaches this from a hand-edited
 *     document, and "the create landed" is the reading that leaves the user
 *     with a terminal rather than a card whose Retry would collide with the
 *     directory that exists.
 *  2. A card with no directory is a team still provisioning.
 *  3. Neither is a team with no directory: null. A `branch` alone names
 *     nothing a team could run in.
 */
export function placementFromFields(fields: PlacementFields): TeamLocation | null {
  if (fields.cwd !== undefined) {
    return fields.branch !== undefined
      ? { kind: "attached", cwd: fields.cwd, branch: fields.branch }
      : { kind: "attached", cwd: fields.cwd };
  }
  if (fields.provisioning) return { kind: "provisioning", intent: fields.provisioning };
  return null;
}

/** The inverse of [`placementFromFields`]: a location as the fields a
 * document carries. Sparse — only what the location holds lands, and of a
 * provisioning team only the intent: its status is this run's, and
 * hydration stamps its own. Round-trips every location the fold can
 * produce. */
export function placementToFields(location: TeamLocation): PlacementFields {
  switch (location.kind) {
    case "attached":
      return location.branch !== undefined
        ? { cwd: location.cwd, branch: location.branch }
        : { cwd: location.cwd };
    case "provisioning":
      return { provisioning: location.intent };
  }
}

/**
 * Where a session resumed from a record runs: the directory it recorded —
 * the workspace root included, which is a directory like any other — with
 * the branch it ran on when the record names one. What a resume or a dir
 * fork asks the landing for.
 *
 * The rule used to live in the resume writer as two conditional spreads,
 * and to treat the root as a placement of its own; it is a fact about what
 * a recorded directory MEANS, so it lives with the placement.
 */
export function placementOfRecorded(record: { cwd: string; branch?: string }): TeamLocation {
  return record.branch !== undefined
    ? { kind: "attached", cwd: record.cwd, branch: record.branch }
    : { kind: "attached", cwd: record.cwd };
}
