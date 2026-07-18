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

/** One-line descriptions only — the frontmatter scalar stays simple.
 * COUPLING PIN: the Rust side (`frontmatter_line` in
 * src-tauri/src/skills.rs) lifts the description as one verbatim line when
 * generating opencode command files; relaxing this to multi-line or block
 * scalars breaks that lift — change both sides together. */
export function isValidSkillDescription(description: string): boolean {
  return !description.includes("\n");
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
    else extraFrontmatter.push(line);
  }
  return { name, description: description ?? "", body: fm.body, extraFrontmatter };
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
