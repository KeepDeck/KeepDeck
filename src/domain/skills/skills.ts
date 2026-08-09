/**
 * Shared agent skills ([skills] — one SKILL.md library, every CLI).
 *
 * A skill is the open Agent Skills format: a directory with a `SKILL.md`
 * whose YAML frontmatter carries `name` + `description`; every supported CLI
 * reads the format and ignores frontmatter keys it doesn't know, so ONE file
 * serves all agents. The library lives under KeepDeck's home (the Rust
 * `skills` adapter moves the bytes); this module owns the schema side:
 * naming rules and frontmatter compose/parse.
 *
 * Parsing is deliberately tolerant and round-trip-safe: the user may hand
 * edit a stored SKILL.md (extra frontmatter like `allowed-tools`, assets in
 * the directory), and a later save from the form must not eat those lines.
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

/** Skill names are standard-format kebab-case directory names. The Rust side
 * re-checks path safety; this is the friendlier authoring rule. */
export function isValidSkillName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name);
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

/** Compose the stored SKILL.md for a draft. */
export function composeSkillFile(draft: SkillDraft): string {
  const lines = [
    "---",
    `name: ${scalar(draft.name)}`,
    `description: ${scalar(draft.description)}`,
    ...draft.extraFrontmatter,
    "---",
  ];
  const body = draft.body.endsWith("\n") || draft.body === "" ? draft.body : `${draft.body}\n`;
  return `${lines.join("\n")}\n${body}`;
}

/** Parse a stored SKILL.md back into a draft. A file without frontmatter is
 * still a skill (name comes from its directory): empty description, the
 * whole content as body. CRLF files are normalized to LF first — a
 * hand-edited Windows-style file must parse (and round-trip), not read as
 * body-only and get its frontmatter demoted into the body on save. A
 * duplicated name/description line keeps the FIRST value; later duplicates
 * go to `extraFrontmatter` verbatim, so nothing is silently lost. */
export function parseSkillFile(content: string): Omit<SkillDraft, "name"> & { name: string | null } {
  const normalized = content.replace(/\r\n/g, "\n");
  const fm = frontmatterBlock(normalized);
  if (!fm) return { name: null, description: "", body: normalized, extraFrontmatter: [] };
  let name: string | null = null;
  let description: string | null = null;
  const extraFrontmatter: string[] = [];
  for (const line of fm.lines) {
    const match = /^(name|description):\s?(.*)$/.exec(line);
    if (match?.[1] === "name" && name === null) name = unscalar(match[2]);
    else if (match?.[1] === "description" && description === null) description = unscalar(match[2]);
    // A LATER duplicate of name/description is dropped, not kept: `compose`
    // emits the extras after the authoritative lines, so keeping it would put
    // the stale value last — and a real YAML parser (which is what every CLI
    // uses on this frontmatter) either takes the last duplicate or refuses the
    // mapping outright. One save would then promote the value the editor just
    // replaced. Nothing meaningful is lost: the kept value is the one this
    // parser, and a last-wins parser after a round trip, already read.
    else if (match) continue;
    else extraFrontmatter.push(line);
  }
  return { name, description: description ?? "", body: fm.body, extraFrontmatter };
}

/** A stored skill as the editable draft. The DIRECTORY name wins over the
 * frontmatter's — the directory is what every CLI keys on, and a hand-edited
 * file can disagree. Takes the stored row structurally, like
 * [`skillScopeOf`], so the domain does not reach for the IPC type mirroring it.
 *
 * Here rather than at a call site because four surfaces need it — the library's
 * `read`, the editor when a skill is opened, the nav's description column, and
 * the `skills.list` command — and a change like "fall back to the first body
 * line when the frontmatter has no description" must reach all four. */
export function skillDraftOf(stored: { name: string; content: string }): SkillDraft {
  return { ...parseSkillFile(stored.content), name: stored.name };
}

function frontmatterBlock(content: string): { lines: string[]; body: string } | null {
  if (!content.startsWith("---\n")) return null;
  const close = content.indexOf("\n---\n", 3);
  if (close === -1) return null;
  return {
    lines: content.slice(4, close).split("\n"),
    body: content.slice(close + 5),
  };
}

/** Quote a value only when YAML would misread it plain. Beyond the risky
 * characters, YAML's core schema turns bare `true`/`null`/`123`-style
 * scalars into booleans/numbers — real CLIs parse this frontmatter with
 * real YAML parsers, so those must be quoted to stay strings (our own
 * regex round-trip would never notice). */
function scalar(value: string): string {
  const reserved = /^(?:true|false|null|yes|no|on|off|~)$/i.test(value);
  const numeric = /^[+-]?(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value);
  // YAML 1.2 core also reads hex/octal ints and the special float tokens as
  // numbers (0x1F → 31, .inf → Infinity) — quoted, they stay strings.
  const special = /^[+-]?(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|\.(?:inf|nan))$/i.test(value);
  const risky =
    value === "" ||
    reserved ||
    numeric ||
    special ||
    /[:#"'\\{}[\],&*?|<>=!%@`]/.test(value) ||
    /^\s|\s$|^-/.test(value);
  return risky ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
}

function unscalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}
