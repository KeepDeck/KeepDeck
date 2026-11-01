/**
 * What staging could not hand agents whole — the native stage's own verdicts
 * (`TrimKind`), a closed set:
 * - a skill handed as its SKILL.md alone: its files are more than one skill
 *   may carry (`too-large`), or the skills before it filled the view
 *   (`no-room`);
 * - a skill not handed at all: not even its SKILL.md fits (`omitted`), its
 *   SKILL.md is no small text file of its own (`skill-file-unreadable`), or
 *   another skill holds its name in the view, one the volume takes for the
 *   same (`skill-name-taken`);
 * - something left out of a skill: a link leading out of it, pointing at
 *   nothing or back into itself, something that is neither file nor folder,
 *   something that could not be read, a name another entry beside it holds
 *   in the copy (`name-taken`), a path too long for the copy.
 *
 * Kinds only — the words for each are the presentation's.
 */
export const STAGING_TRIM_KINDS = [
  "too-large",
  "no-room",
  "omitted",
  "skill-file-unreadable",
  "skill-name-taken",
  "link-out",
  "link-dangles",
  "link-cycle",
  "special",
  "unreadable",
  "name-taken",
  "path-too-long",
] as const;

export type StagingTrimKind = (typeof STAGING_TRIM_KINDS)[number];

/** One skill a stage could not hand out whole. */
export interface StagingTrim {
  scope: "global" | "workspace" | "bundled";
  skill: string;
  kind: StagingTrimKind;
  /** For something left out of the skill: the first such path inside it. */
  path: string | null;
  /** How many of that kind were left out of it; 1 for the skill itself. */
  count: number;
}
