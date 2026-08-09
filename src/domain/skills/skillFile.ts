/**
 * The SKILL.md CODEC: how a skill is written to a file and read back.
 *
 * Its own module beside `skills.ts`, which owns the RULES (what a scope is, what
 * a valid name or description is). The two have different reasons to change —
 * this half moves when the FORMAT does (a block scalar to understand, a line
 * ending to tolerate, a key to lift), the other when the product's vocabulary
 * does — and this is the half carrying a cross-language coupling pin to
 * `frontmatter_line` in src-tauri/src/skills/opencode.rs. Same split the
 * repo's other domain areas already make (`settings/codecs.ts`,
 * `journal/persist.ts`, `mcp/jsonrpc.ts`).
 *
 * Parsing is deliberately tolerant and round-trip-safe: the user may hand edit
 * a stored SKILL.md (extra frontmatter like `allowed-tools`, assets in the
 * directory), and a later save from the form must not eat those lines.
 */
import type { SkillDraft } from "./skills";

/** How the `name:` key is written. Shared with [`renameSkillFile`]'s splice,
 * which both emits this line and compares against it to tell whether there is
 * anything to rewrite — two spellings would make that check answer "yes" on
 * every rename. */
const nameLine = (name: string): string => `name: ${scalar(name)}`;

/** Compose the stored SKILL.md for a draft. */
export function composeSkillFile(draft: SkillDraft): string {
  const lines = [
    "---",
    nameLine(draft.name),
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
 * go to `extraFrontmatter` verbatim, so nothing is silently lost.
 *
 * A `name`/`description` written as a BLOCK SCALAR (`>` or `|`) is read
 * WHOLE — header plus its indented lines, folded onto the one line this schema
 * says a value is. Reading only the header left the continuation lines in
 * `extraFrontmatter`, where `compose` re-emitted them below a finished
 * `description: ">"` entry; that is orphaned indentation, which every CLI's YAML
 * reader refuses outright. A hand-written block scalar is valid YAML, so it must
 * survive being opened and saved. */
export function parseSkillFile(content: string): Omit<SkillDraft, "name"> & { name: string | null } {
  const normalized = content.replace(/\r\n/g, "\n");
  const fm = frontmatterBlock(normalized);
  if (!fm) return { name: null, description: "", body: normalized, extraFrontmatter: [] };
  let name: string | null = null;
  let description: string | null = null;
  const extraFrontmatter: string[] = [];
  for (let i = 0; i < fm.lines.length; i++) {
    const match = /^(name|description):\s?(.*)$/.exec(fm.lines[i]);
    if (!match) {
      extraFrontmatter.push(fm.lines[i]);
      continue;
    }
    const block = blockScalar(fm.lines, i, match[2]);
    // Consumed whether or not the value is kept: a later duplicate's
    // continuation lines must not be left behind either.
    if (block) i = block.through;
    const value = block ? block.value : unscalar(match[2]);
    if (match[1] === "name" && name === null) name = value;
    else if (match[1] === "description" && description === null) description = value;
    // A LATER duplicate of name/description is dropped, not kept: `compose`
    // emits the extras after the authoritative lines, so keeping it would put
    // the stale value last — and a real YAML parser (which is what every CLI
    // uses on this frontmatter) either takes the last duplicate or refuses the
    // mapping outright. One save would then promote the value the editor just
    // replaced. Nothing meaningful is lost: the kept value is the one this
    // parser, and a last-wins parser after a round trip, already read.
  }
  return { name, description: description ?? "", body: fm.body, extraFrontmatter };
}

/** A block scalar header (`>`, `|`, with any chomping/indentation indicator)
 * and the indented lines under it, folded onto one line — or `null` when the
 * value is an ordinary scalar. `through` is the last line index it consumed.
 *
 * Folding rather than preserving the breaks, for both forms: this schema's two
 * keys are single-line by contract (see [`skillDescriptionProblem`]), so the
 * meaning of the value is what has to survive the round trip, not its layout. */
function blockScalar(
  lines: string[],
  at: number,
  header: string,
): { value: string; through: number } | null {
  if (!/^[|>][+-]?\d*$/.test(header.trim())) return null;
  const parts: string[] = [];
  let through = at;
  for (let i = at + 1; i < lines.length; i++) {
    // The block runs to the first line that is not indented; a blank line
    // inside it belongs to it.
    if (lines[i].trim() !== "" && !/^[ \t]/.test(lines[i])) break;
    parts.push(lines[i].trim());
    through = i;
  }
  return { value: parts.filter((part) => part !== "").join(" "), through };
}

/** The first extra frontmatter line that a re-composed file could NOT carry, or
 * `null` when every extra can be re-emitted safely.
 *
 * `compose` writes `name:` and `description:` first and the extras after them,
 * so an extras block whose first line is a CONTINUATION — indented, or a
 * sequence dash — lands under a finished mapping entry and turns valid YAML into
 * frontmatter no reader accepts. That is unrepresentable rather than merely
 * reformatted, so the caller that would author over it has to refuse instead.
 *
 * An indented run LATER in the extras is fine: it continues an extra key that
 * was itself re-emitted just above it, which is how a hand-added
 * `allowed-tools: >` block survives a save. */
export function orphanedFrontmatterLine(extraFrontmatter: string[]): string | null {
  const first = extraFrontmatter.find((line) => line.trim() !== "");
  return first !== undefined && /^[\s-]/.test(first) ? first : null;
}

/** The stored SKILL.md with its frontmatter `name:` moved onto `name`, and
 * every other byte — line endings, hand-added keys, block scalars, the body —
 * left exactly as it was. `null` when there is nothing to rewrite: no
 * frontmatter, no `name:` line in it, or one that already says `name`. Such a
 * file takes its name from the directory and so cannot contradict it, which
 * means renaming it is the directory move alone.
 *
 * A SPLICE rather than parse-then-compose, because a rename authors nothing.
 * Round-tripping a hand-written file through the composer rewrites lines the
 * user owns, and even now that it can carry a block scalar it carries the
 * MEANING, not the layout — a rename has no business reformatting a file it was
 * asked to move. The composer's job is a draft someone authored HERE; this
 * one's is a file that already exists. */
export function renameSkillFile(content: string, name: string): string | null {
  const span = frontmatterSpan(content);
  if (!span) return null;
  // The FIRST `name:` line, matching the parser's first-wins reading — a later
  // duplicate is a line the parser already drops. Anchored on an explicit `\n`
  // for the same reason as `frontmatterSpan`: a multiline `^` also matches after
  // a lone CR, and splicing there would rewrite the tail of somebody's value.
  const line = /(?:^|(\n))name:[^\r\n]*/.exec(content.slice(span.start, span.end));
  if (!line) return null;
  const current = line[1] ? line[0].slice(1) : line[0];
  const rewritten = nameLine(name);
  if (current === rewritten) return null;
  const at = span.start + line.index + (line[1] ? 1 : 0);
  return content.slice(0, at) + rewritten + content.slice(at + current.length);
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

/** Where the frontmatter sits inside the content: the fenced region's own
 * lines as `[start, end)` — `end` includes the last line's terminator — plus
 * where the body begins after the closing fence.
 *
 * ONE home for "where does the frontmatter begin and end", because two things
 * ask it and must agree: the parser, which reads the block, and
 * [`renameSkillFile`], which splices a single line back into it. CRLF-tolerant
 * for the splice's sake — the parser normalizes before it gets here, but the
 * splice works on the stored bytes and must not go looking for LF in a
 * hand-edited Windows file. */
function frontmatterSpan(
  content: string,
): { start: number; end: number; bodyAt: number } | null {
  const open = /^---\r?\n/.exec(content);
  if (!open) return null;
  const start = open[0].length;
  // Anchored on an explicit `\n`, NOT the `m` flag: in JS a multiline `^` also
  // matches after a lone CR, so `m` found a fence inside a classic-Mac file the
  // parser reads as one long line — and then its keys came back as EXTRAS, which
  // compose re-emitted as a duplicate `name:`. Only a real line break opens a
  // frontmatter line.
  // A closing fence at END OF FILE counts, with or without a trailing newline:
  // real YAML readers accept it, so treating that file as body-only meant the
  // editor showed no description and the next save wrote the original
  // frontmatter back as BODY text under a fresh one.
  const close = /(?:^|(\n))---(?:\r?\n|$)/.exec(content.slice(start));
  if (!close) return null;
  const fenceAt = close.index + (close[1] ? 1 : 0);
  const fence = close[1] ? close[0].slice(1) : close[0];
  return { start, end: start + fenceAt, bodyAt: start + fenceAt + fence.length };
}

function frontmatterBlock(content: string): { lines: string[]; body: string } | null {
  const span = frontmatterSpan(content);
  if (!span) return null;
  return {
    // The last frontmatter line's own newline is a terminator, not an empty
    // line after it.
    lines: content.slice(span.start, span.end).replace(/\n$/, "").split("\n"),
    body: content.slice(span.bodyAt),
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
