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
 * Reading and writing the file itself is the plugin contract's SKILL.md codec
 * (`@keepdeck/plugin-api`): a format change and a vocabulary change are
 * different reasons to change.
 */
import { hasUsableSkillDescription } from "@keepdeck/plugin-api";

/** Where a skill lives — its distribution boundary. The third kind is the
 * BUNDLED tier: first-party skills shipped inside the app binary, read-only,
 * never in the user's library (the editor shows them in their own section;
 * staging materializes them for agents behind the feature gate). */
export type SkillScope =
  | { kind: "global" }
  | { kind: "workspace"; wsId: string }
  | { kind: "bundled" };

/** The scopes a skill can be AUTHORED into — every scope but the bundled
 * tier, which is read-only by construction. What a write names. */
export type SkillLibraryScope = Exclude<SkillScope, { kind: "bundled" }>;

/** Whether two scopes name the SAME library. Here rather than at a call site
 * because every surface that groups, filters or looks a skill up asks it, and
 * two copies of the workspace-id comparison would drift. */
export function sameSkillScope(a: SkillScope, b: SkillScope): boolean {
  if (a.kind === "bundled") return b.kind === "bundled";
  if (a.kind === "global") return b.kind === "global";
  return b.kind === "workspace" && a.wsId === b.wsId;
}

/** The scope a stored skill lives in. Takes the stored row's shape structurally
 * — the domain must not reach for the IPC type that mirrors it. A workspace row
 * with no id is malformed rather than global: it keeps an empty id, which
 * matches no REAL workspace and so stays out of every live library. (Two such
 * rows do match each other — the id is compared, not vetted — so a caller must
 * not manufacture an empty id and expect it to match nothing.) */
export function skillScopeOf(stored: {
  scope: "global" | "workspace" | "bundled";
  wsId: string | null;
}): SkillScope {
  if (stored.scope === "bundled") return { kind: "bundled" };
  return stored.scope === "global"
    ? { kind: "global" }
    : { kind: "workspace", wsId: stored.wsId ?? "" };
}

/** Which skill a caller means: a library, and a name within it. */
export interface SkillRef {
  scope: SkillScope;
  name: string;
}

/** Whether two references name the SAME skill.
 *
 * Here rather than at a call site because four places asked it by hand — the
 * editor's row lookup, its active-row highlight, its same-row click guard, and
 * the library's existence check — and identity is exactly the kind of rule that
 * grows: the day names become case-insensitive, three of those four would keep
 * the old answer and the nav would stop highlighting the row the editor has open. */
export const sameSkillRef = (a: SkillRef, b: SkillRef): boolean =>
  a.name === b.name && sameSkillScope(a.scope, b.scope);

/** A scope as a stable string — for a React key, a map key, a log line. Here
 * rather than at a call site because it was computed twice in one component, and
 * "how do you flatten a scope" is the kind of question that must not have two
 * answers the day a scope gains a third kind. */
export const skillScopeKey = (scope: SkillScope): string =>
  scope.kind === "global"
    ? "global"
    : scope.kind === "bundled"
      ? "bundled"
      : `ws:${scope.wsId}`;

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

/** The stored skills no agent may be handed: those whose description, as the
 * shared codec lifts it, says nothing. They stay in the library — listed and
 * editable, which is how they get fixed — and stage nowhere: agents choose a
 * skill by its description, and one CLI refused its whole configuration over
 * a skill without one. */
export function skillsUnfitForAgents<T extends { content: string }>(rows: readonly T[]): T[] {
  return rows.filter((row) => !hasUsableSkillDescription(row.content));
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
 * Single-line for every agent (user decision): a description is one line in
 * every layout a skill is copied into, and the editor folds a pasted one
 * (`normalizeSkillDescription`) before it gets here. */
export function skillDescriptionProblem(
  description: string,
): "empty" | "multiline" | null {
  if (description.trim() === "") return "empty";
  return description.includes("\n") ? "multiline" : null;
}
