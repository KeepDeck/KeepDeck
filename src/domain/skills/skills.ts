/**
 * Shared agent skills ([skills] — one SKILL.md library, every CLI).
 *
 * A skill is the open Agent Skills format: a directory with a `SKILL.md`
 * whose YAML frontmatter carries `name` + `description`; every supported CLI
 * reads the format and ignores frontmatter keys it doesn't know, so ONE file
 * serves all agents. The library lives under KeepDeck's home (the Rust
 * `skills` adapter moves the bytes); this module owns the RULES — where a skill
 * lives, what a draft is, and what makes a name or a description acceptable.
 *
 * Reading and writing the file itself is `skillFile.ts` next door: a format
 * change and a vocabulary change are different reasons to change, and only one
 * of them is pinned to the Rust side.
 */

/** Where a skill lives — its distribution boundary. */
export type SkillScope = { kind: "global" } | { kind: "workspace"; wsId: string };

/** Whether two scopes name the SAME library. Here rather than at a call site
 * because every surface that groups, filters or looks a skill up asks it, and
 * two copies of the workspace-id comparison would drift. */
export function sameSkillScope(a: SkillScope, b: SkillScope): boolean {
  return a.kind === "global"
    ? b.kind === "global"
    : b.kind === "workspace" && a.wsId === b.wsId;
}

/** The scope a stored skill lives in. Takes the stored row's shape structurally
 * — the domain must not reach for the IPC type that mirrors it. A workspace row
 * with no id is malformed rather than global: it keeps an empty id, which
 * matches no REAL workspace and so stays out of every live library. (Two such
 * rows do match each other — the id is compared, not vetted — so a caller must
 * not manufacture an empty id and expect it to match nothing.) */
export function skillScopeOf(stored: {
  scope: "global" | "workspace";
  wsId: string | null;
}): SkillScope {
  return stored.scope === "global"
    ? { kind: "global" }
    : { kind: "workspace", wsId: stored.wsId ?? "" };
}

/** A skill split into what the editor form works with. */
export interface SkillDraft {
  name: string;
  description: string;
  /** Markdown instructions below the frontmatter. */
  body: string;
  /** Frontmatter lines OTHER than name/description, kept verbatim so a
   * form save round-trips hand-added keys (`allowed-tools`, `license`…). */
  extraFrontmatter: string[];
}

/** The naming rule in words, for whoever has to explain a refusal. Here beside
 * the regex because three surfaces were each describing it from memory and all
 * three described a SUBSET: `my-skill-` is "lowercase letters, digits and
 * hyphens only", and was still refused. */
export const SKILL_NAME_RULE =
  "lowercase letters, digits and hyphens, not starting or ending with a hyphen, 64 characters at most";

/** What is wrong with a skill name, or `null` when nothing is.
 *
 * A VERDICT rather than a predicate, for the reason [`skillDescriptionProblem`]
 * is one: a caller needs the same answer for its gate and for what it puts on
 * screen, and with only a boolean the editor derived the two separately and they
 * drifted — an emptied Name field disabled Save with nothing explaining it,
 * because "empty" was folded into "invalid" at the gate and excluded from the
 * message. Skill names are standard-format kebab-case directory names; the Rust
 * side re-checks path safety, this is the friendlier authoring rule. */
export function skillNameProblem(name: string): "empty" | "invalid" | null {
  if (name.trim() === "") return "empty";
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name) ? null : "invalid";
}

/** What is wrong with a description, or `null` when nothing is.
 *
 * ONE verdict rather than two predicates, because both conditions always apply
 * together and in order: "non-empty" is the one that rejects real input, and it
 * used to be an extra `&&` each caller had to remember — written twice in the
 * editor and again in the library, while the predicate that LOOKED shared
 * (`multiline`) cannot fail once the text has been normalized. Callers render
 * the reason in their own words; the rule itself lives here.
 *
 * Empty is refused rather than merely discouraged: agents pick skills by
 * description, and some drop a skill that has none, so such a skill would save
 * and never take effect.
 *
 * COUPLING PIN on the multiline arm: the Rust side (`frontmatter_line` in
 * src-tauri/src/skills/opencode.rs) lifts the description as one verbatim line
 * when generating opencode command files; relaxing this to multi-line or block
 * scalars breaks that lift — change both sides together. */
export function skillDescriptionProblem(
  description: string,
): "empty" | "multiline" | null {
  if (description.trim() === "") return "empty";
  return description.includes("\n") ? "multiline" : null;
}

/** Fold edited description text onto that one line: newline runs (and the
 * indentation around them) become single spaces, so a multi-line paste
 * lands as a valid scalar instead of tripping validation. */
export function normalizeSkillDescription(description: string): string {
  return description.replace(/[^\S\r\n]*[\r\n]+\s*/g, " ");
}
