/**
 * Reading a pane's location, and folding the four on-disk fields into one.
 *
 * The model holds ONE location ([`PaneLocation`]); the document still holds
 * the four fields it replaced, so that no deck on disk changed shape. This
 * module is both halves of that: the accessor every reader uses, and the fold
 * the persistence boundary applies on the way in — where a combination the
 * fields allow but the meaning does not is settled by one written rule,
 * rather than by whichever consumer happened to look first.
 */
import type { Pane, PaneLocation, PaneProvisioning, WorktreeIntent } from "./model";

const MAIN: PaneLocation = { kind: "main" };

/** Where the pane runs. Absent on the model means `main`. */
export function locationOf(pane: Pick<Pane, "location">): PaneLocation {
  return pane.location ?? MAIN;
}

/** The four fields a document carries in place of a location. The
 * `provisioning` slot is the create's intent alone: a card's status — the
 * error it shows, the fork it came from — is runtime and never reaches disk. */
export interface PlacementFields {
  cwd?: string;
  branch?: string;
  remoteEndpoint?: string;
  provisioning?: WorktreeIntent;
}

/**
 * Fold the document's placement fields into a location.
 *
 * The rule, in order of precedence:
 *
 *  1. A truthy `remoteEndpoint` makes the pane remote, whatever else is set —
 *     "the local location is moot", as the factory puts it. Truthy rather
 *     than present, matching the predicate this replaced: an empty endpoint
 *     is the non-remote degenerate case.
 *  2. A `cwd` makes the pane attached. A provisioning card beside it is
 *     dropped: the resolve transition writes the directory and removes the
 *     card in one step, so the pair only ever reaches this from a hand-edited
 *     document, and "the create landed" is the reading that leaves the user
 *     with a terminal rather than a card whose Retry would collide with the
 *     directory that exists.
 *  3. A card with no directory is a pane still provisioning.
 *  4. Anything else runs in the workspace cwd, keeping a `branch` if one is
 *     recorded: a session resumed from the workspace root arrives with the
 *     branch it ran on and no directory, and surfaces still name it.
 */
export function placementFromFields(fields: PlacementFields): PaneLocation {
  if (fields.remoteEndpoint) return { kind: "remote", endpoint: fields.remoteEndpoint };
  if (fields.cwd !== undefined) {
    return fields.branch !== undefined
      ? { kind: "attached", cwd: fields.cwd, branch: fields.branch }
      : { kind: "attached", cwd: fields.cwd };
  }
  if (fields.provisioning) return { kind: "provisioning", intent: fields.provisioning };
  return fields.branch !== undefined ? { kind: "main", branch: fields.branch } : MAIN;
}

/**
 * Where a pane resumed from a recorded session runs: its own directory when
 * the record names one apart from the workspace cwd, else the workspace cwd
 * with the branch the session ran on. Undefined for a plain main pane, so
 * the caller can spread it sparsely like every other field.
 *
 * The rule used to live in the resume writer as two conditional spreads;
 * it is a fact about what a recorded directory MEANS, so it lives with the
 * location.
 */
export function placementOfRecorded(
  record: { cwd: string; branch?: string },
  workspaceCwd: string,
): PaneLocation | undefined {
  if (record.cwd !== workspaceCwd) {
    return record.branch !== undefined
      ? { kind: "attached", cwd: record.cwd, branch: record.branch }
      : { kind: "attached", cwd: record.cwd };
  }
  return record.branch !== undefined ? { kind: "main", branch: record.branch } : undefined;
}

/** The inverse of [`placementFromFields`]: a location as the four fields a
 * document carries. Sparse — only what the location holds lands, and of a
 * provisioning pane only the intent: its status is this run's, and hydration
 * stamps its own. Round-trips every location the fold can produce. */
export function placementToFields(location: PaneLocation): PlacementFields {
  switch (location.kind) {
    case "main":
      return location.branch !== undefined ? { branch: location.branch } : {};
    case "attached":
      return location.branch !== undefined
        ? { cwd: location.cwd, branch: location.branch }
        : { cwd: location.cwd };
    case "provisioning":
      return { provisioning: location.intent };
    case "remote":
      return { remoteEndpoint: location.endpoint };
  }
}

/** The worktree an attached pane runs in, or null for any other placement.
 * The projection five app-layer readers want — "the pane's own directory,
 * if it has one" — so none of them spells the match out. */
export function attachedWorktree(
  pane: Pick<Pane, "location">,
): { cwd: string; branch?: string } | null {
  const location = locationOf(pane);
  return location.kind === "attached" ? location : null;
}

/** The card a provisioning pane wears — its create's intent and the status
 * the card shows — or null for any other placement: what a surface that
 * draws the card asks, in the shape its prop takes. */
export function provisioningCard(pane: Pick<Pane, "location">): PaneProvisioning | null {
  const location = locationOf(pane);
  return location.kind === "provisioning" ? location : null;
}

/** The branch a pane's work is on, whether it owns a worktree for it or
 * recorded it from the workspace root — or nothing, for a pane whose create
 * is in flight or whose agent runs elsewhere. */
export function paneBranch(pane: Pick<Pane, "location">): string | undefined {
  const location = locationOf(pane);
  switch (location.kind) {
    case "main":
    case "attached":
      return location.branch;
    case "provisioning":
    case "remote":
      return undefined;
  }
}
