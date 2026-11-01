import type { StagingTrim, StagingTrimKind } from "../domain/skills";

/** One stage's verdict as this view reads it: the trim, and the workspace
 * lifetime whose stage said it. */
type Trim = StagingTrim & { workspaceInstance: string; workspaceName: string };

/** What the list is titled. */
export const STAGING_TRIMS_TITLE = "Some skills do not reach agents whole:";

export interface StagingTrimLine {
  key: string;
  text: string;
}

/** What became of the skill, or of what was left out of it. */
function verdict(kind: StagingTrimKind): string {
  switch (kind) {
    case "too-large":
      return "larger than one skill may be — agents get its SKILL.md alone";
    case "no-room":
      return "the skills together are more than agents can be given — this one goes as its SKILL.md alone";
    case "omitted":
      return "no room is left even for its SKILL.md — agents do not get it";
    case "skill-file-unreadable":
      return "its SKILL.md is not a small text file of its own — agents do not get it";
    case "skill-name-taken":
      return "the disk takes another skill's name for the same one (they differ only in letter case or accents) — agents do not get it";
    case "link-out":
      return "links outside the skill — left out";
    case "link-dangles":
      return "links to nothing — left out";
    case "link-cycle":
      return "links back into itself — left out";
    case "special":
      return "is neither a file nor a folder — left out";
    case "unreadable":
      return "could not be read — left out";
    case "name-taken":
      return "the disk takes the name of another entry beside it for the same one (they differ only in letter case or accents) — left out";
    case "path-too-long":
      return "its path is too long to copy — left out";
  }
}

/** One line per thing to fix: the skill, or the path inside it, a workspace
 * skill's workspace, and what became of it. A global or bundled skill stages
 * into every workspace alike, so what several stages said of it is one line;
 * a workspace skill is its own workspace's, however that workspace is named. */
export function stagingTrimLines(trims: readonly Trim[]): StagingTrimLine[] {
  const lines = new Map<string, StagingTrimLine>();
  for (const trim of trims) {
    const at = trim.path === null ? trim.skill : `${trim.skill}/${trim.path}`;
    const own = trim.scope === "workspace";
    const where = own ? ` (in ${trim.workspaceName})` : "";
    const more = trim.count > 1 ? ` (and ${trim.count - 1} more like it)` : "";
    const text = `${at}${where}: ${verdict(trim.kind)}${more}`;
    const key = own ? `${trim.workspaceInstance}\0${text}` : text;
    lines.set(key, { key, text });
  }
  return [...lines.values()];
}
