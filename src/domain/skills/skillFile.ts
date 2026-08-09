/**
 * The SKILL.md CODEC: how a skill is written to a file and read back.
 *
 * Its own module beside `skills.ts`, which owns the RULES (what a scope is, what
 * a valid name or description is). The two have different reasons to change —
 * this half moves when the FORMAT does, the other when the product's vocabulary
 * does. Same split the repo's other domain areas already make
 * (`settings/codecs.ts`, `journal/persist.ts`, `mcp/jsonrpc.ts`).
 *
 * READING goes through the `yaml` package, not through regexes of our own.
 * That is the whole design of this module, and it was learned the hard way: a
 * hand-rolled reader kept being *nearly* right, and every shape it did not model
 * turned into silent corruption on the next save — a `description: >` read as the
 * literal ">" with its continuation lines stranded, a `"name":` spelling that
 * came back as a duplicate key, a fence with trailing spaces that demoted the
 * whole frontmatter into the body. The contract is not "our regexes agree with
 * themselves"; it is "a real YAML parser reads what we wrote", because a real
 * YAML parser is what every supported CLI reads this file with. So we use one.
 *
 * WRITING stays ours ([`composeSkillFile`]): the file KeepDeck authors is
 * deliberately the simplest possible shape, and we would rather pin those exact
 * bytes than inherit a serializer's formatting choices.
 *
 * Because reading and writing are asymmetric, [`frontmatterObstacle`] is the
 * bridge: it answers "could we re-emit this file at all", and the only writer
 * that authors over an existing file has to ask it first.
 */
import {
  isMap,
  isScalar,
  parseDocument,
  visit,
  type Document,
  type Pair,
} from "yaml";
import { normalizeSkillDescription, type SkillDraft } from "./skills";

/** How the `name:` key is written. Shared with [`renameSkillFile`]'s splice,
 * which both emits this line and compares against it to tell whether there is
 * anything to rewrite — two spellings would make that check answer "yes" on
 * every rename. */
const nameLine = (name: string): string => `name: ${scalar(name)}`;

/** Compose the stored SKILL.md for a draft.
 *
 * The frontmatter takes the BODY's line ending, so a Windows-authored file does
 * not come back with CRLF below the fence and LF above it — an edit to one field
 * has no business changing how the rest of the file is written. */
export function composeSkillFile(draft: SkillDraft): string {
  const eol = /\r\n/.test(draft.body) && !/[^\r]\n/.test(draft.body) ? "\r\n" : "\n";
  const lines = [
    "---",
    nameLine(draft.name),
    `description: ${scalar(draft.description)}`,
    ...draft.extraFrontmatter,
    "---",
  ];
  const body = draft.body.endsWith("\n") || draft.body === "" ? draft.body : `${draft.body}${eol}`;
  // Normalize FIRST, then apply: a hand-added entry carried over from a CRLF file
  // already holds `\r\n`, and substituting into that would double the CR.
  return `${lines.join("\n").replace(/\r?\n/g, eol)}${eol}${body}`;
}

/**
 * Parse a stored SKILL.md into a draft.
 *
 * Exported for this module's OWN suite and for [`skillDraftOf`], which is what
 * every surface actually calls — the nullable `name` here is the raw reading, and
 * the directory-wins rule that makes it usable lives there. Nothing outside this
 * folder should reach past that rule.
 *
 * A file without readable frontmatter is still a skill — the name comes from its
 * directory: empty description, the whole content as body.
 *
 * `name` and `description` are read as the values a YAML reader sees, then folded
 * onto the one line this schema says they are (see [`skillDescriptionProblem`]);
 * that covers every scalar style, both block-scalar forms with any indicator, and
 * the escapes and comments a quoted scalar can carry. Every OTHER entry is kept
 * as its verbatim source text so a save round-trips hand-added keys — comments,
 * block scalars and nested values included — and duplicated `name`/`description`
 * entries keep the FIRST, dropping the shadowed one rather than re-emitting a
 * value the editor just replaced.
 */
export function parseSkillFile(
  content: string,
): Omit<SkillDraft, "name"> & { name: string | null } {
  const fm = frontmatter(content);
  if (!fm) return { name: null, description: "", body: content, extraFrontmatter: [] };
  let name: string | null = null;
  let description: string | null = null;
  const extraFrontmatter: string[] = [];
  for (const entry of fm.entries) {
    // LAST wins for our two keys, because that is what the reader this codec is
    // configured as resolves. (Such a file is refused for writing — see
    // [`frontmatterObstacle`] — so this only decides what is displayed, and what
    // is displayed should be what the agents read.)
    if (entry.key === "name") name = entry.value;
    else if (entry.key === "description") description = entry.value;
    else extraFrontmatter.push(entry.source);
  }
  const tail = fm.tail.trim() === "" ? null : fm.tail.replace(/^\n+|\s+$/g, "");
  if (tail !== null) extraFrontmatter.push(tail);
  return { name, description: description ?? "", body: fm.body, extraFrontmatter };
}

/** The frontmatter's own text, exactly as this codec locates it — `null` when the
 * file has none.
 *
 * Exported for the suite that checks this codec against a real YAML reader: that
 * suite had a fence-finder of its OWN, which is a third hand-rolled reader in the
 * one file written because hand-rolled readers kept being nearly right, and the
 * two already disagreed on an empty fenced block. The oracle that has to stay
 * independent there is the PARSE, not the fence scan. */
export function frontmatterTextOf(content: string): string | null {
  const span = frontmatterSpan(content);
  return span ? content.slice(span.start, span.end) : null;
}

/**
 * Why this file's frontmatter cannot be re-authored, or `null` when it can.
 *
 * [`composeSkillFile`] writes `name:` and `description:` first and the other
 * entries after them, so re-authoring is only safe when every kept entry can
 * stand at column 0 in that order and mean the same thing. Frontmatter that is
 * not valid YAML, is not a mapping, or is written as an INDENTED mapping fails
 * that — re-emitting its entries under our two lines turns a file every CLI
 * reads into one none of them accept.
 *
 * Refusing is the point. A skill that cannot be edited in this app is
 * recoverable with a text editor; one silently rewritten into something no agent
 * can read is not.
 */
export function frontmatterObstacle(content: string): string | null {
  const fm = frontmatter(content);
  return fm ? fm.obstacle : null;
}

/** What a rename could do to the stored file. */
export type SkillFileRename =
  /** Its frontmatter states no name, so it cannot contradict the directory and
   * the move is the whole rename. */
  | { kind: "unchanged" }
  | { kind: "rewritten"; content: string }
  /** The frontmatter states a name but we cannot restate it without risking the
   * file — the caller must refuse the rename rather than move the directory and
   * leave the two disagreeing. */
  | { kind: "unsupported"; reason: string };

/**
 * The stored SKILL.md with its frontmatter `name:` moved onto `name`.
 *
 * A byte-preserving SPLICE where it can be: a rename authors nothing, so line
 * endings, hand-added keys, comments and block scalars must survive it exactly.
 * That is only sound when the stored name is a single-line scalar at column 0 —
 * splicing the HEADER of a block-scalar name left its old value orphaned
 * underneath, which is a different name again. For a name we cannot splice we
 * re-compose the whole file, which is safe precisely when
 * [`frontmatterObstacle`] says nothing, and refuse otherwise.
 */
export function renameSkillFile(content: string, name: string): SkillFileRename {
  const fm = frontmatter(content);
  if (!fm) return { kind: "unchanged" };
  // An obstacle FIRST, because it also means we cannot tell whether this file
  // states a name: an indented mapping states one a reader sees perfectly well,
  // and answering "nothing to rewrite" there moved the directory and left the
  // file naming the old skill. Slightly over-strict for frontmatter that is not a
  // mapping at all (it states no name, so a move alone would be fine), and that
  // is the right way to be wrong here.
  if (fm.obstacle) return { kind: "unsupported", reason: fm.obstacle };
  const stated = fm.entries.find((entry) => entry.key === "name");
  if (!stated) return { kind: "unchanged" };
  if (stated.splice) {
    const rewritten = nameLine(name);
    if (stated.splice.text === rewritten) return { kind: "unchanged" };
    const at = fm.start + stated.splice.at;
    return {
      kind: "rewritten",
      content:
        content.slice(0, at) + rewritten + content.slice(at + stated.splice.text.length),
    };
  }
  // A name we cannot splice — a block scalar, say — but a file we CAN re-emit, so
  // re-compose the whole thing rather than refuse. Sound because the obstacle
  // check above already passed.
  const parsed = parseSkillFile(content);
  return { kind: "rewritten", content: composeSkillFile({ ...parsed, name }) };
}

/** A stored skill as the editable draft. The DIRECTORY name wins over the
 * frontmatter's — the directory is what every CLI keys on, and a hand-edited
 * file can disagree. Takes the stored row structurally, like [`skillScopeOf`],
 * so the domain does not reach for the IPC type mirroring it.
 *
 * Here rather than at a call site because four surfaces need it — the library's
 * `read`, the editor when a skill is opened, the nav's description column, and
 * the `skills.list` command — and a change like "fall back to the first body
 * line when the frontmatter has no description" must reach all four. */
export function skillDraftOf(stored: { name: string; content: string }): SkillDraft {
  return { ...parseSkillFile(stored.content), name: stored.name };
}

interface FrontmatterEntry {
  key: string;
  /** The value a YAML reader sees, folded onto one line for the two keys this
   * schema owns. */
  value: string;
  /** The entry's verbatim source, re-emitted as-is when it is not ours. It runs
   * from the END OF THE PREVIOUS ENTRY, so a comment line standing above this key
   * — which belongs to no entry's own range — travels with the key it annotates
   * instead of being dropped. */
  source: string;
  /** What this entry consumed of the frontmatter text, so the next one's slice
   * begins where this stopped. Differs from `source` by the leading newline. */
  span: string;
  /** The `key: value` span, comment excluded: what a splice replaces. Keeping the
   * comment out of it is why `name: old # the id` keeps its note through a
   * rename. */
  splice: { at: number; text: string } | null;
}

interface Frontmatter {
  entries: FrontmatterEntry[];
  body: string;
  /** Offset of the frontmatter text within the whole file. */
  start: number;
  obstacle: string | null;
  /** Whatever follows the last entry — a comment before the closing fence, which
   * belongs to no entry's range and would otherwise be dropped. */
  tail: string;
}

/** The fenced frontmatter, read with a real YAML parser, plus everything the
 * writers need to know about re-emitting it. `null` when the file has no fenced
 * frontmatter at all, which is a legitimate skill. */
function frontmatter(content: string): Frontmatter | null {
  const span = frontmatterSpan(content);
  if (!span) return null;
  const text = content.slice(span.start, span.end);
  const body = content.slice(span.bodyAt);
  // Duplicates tolerated rather than rejected: this parser keeps the first and
  // drops the shadowed one, which repairs the file on the next save instead of
  // refusing to open it.
  // Duplicates are TOLERATED by the parser and REFUSED by the obstacle check
  // below: with `uniqueKeys` on, a shadowed key makes the whole document
  // unreadable and the skill unopenable; off, we can still show it. What we must
  // not do is author over it, because a strict reader refuses the file outright
  // and a lenient one resolves LAST-wins, so any value we picked would be a
  // value some reader disagrees with.
  const doc = parseDocument(text, { uniqueKeys: false });
  const obstacle = obstacleIn(doc, text);
  // An EMPTY fenced block — or one holding only comments — is readable and has no
  // entries: `contents` is null there, which is nothing to carry, not an obstacle.
  const items = isMap(doc.contents) ? (doc.contents.items as Pair[]) : [];
  const entries: FrontmatterEntry[] = [];
  let cursor = 0;
  for (const pair of items) {
    const entry = entryOf(pair, text, cursor);
    if (!entry) continue;
    entries.push(entry);
    cursor = cursor + entry.span.length;
  }
  return { entries, body, start: span.start, obstacle, tail: text.slice(cursor) };
}

/** Why `doc` cannot be re-emitted entry-by-entry at column 0, or `null`.
 *
 * Every arm is a shape a real reader accepts and our composer would change the
 * meaning of. The rule this enforces is "either refuse, or preserve" — never
 * rewrite into something a CLI reads differently. */
function obstacleIn(doc: Document, text: string): string | null {
  if (doc.errors.length > 0) {
    return `its frontmatter is not valid YAML (${doc.errors[0].message})`;
  }
  if (doc.contents === null) return null;
  if (!isMap(doc.contents)) return "its frontmatter is not a list of keys";
  // An anchor is defined in one entry and used in another, so re-emitting the two
  // keys we own drops a `&name` something else still refers to — and the file
  // stops parsing entirely with "unresolved alias". An alias as one of OUR values
  // is the same problem from the other side: we would write the resolved text and
  // silently break whoever shared it.
  let shared: string | null = null;
  visit(doc, {
    Node(_key, node) {
      if (node.anchor !== undefined && shared === null) shared = `&${node.anchor}`;
    },
    Alias(_key, node) {
      if (shared === null) shared = `*${node.source}`;
    },
  });
  if (shared !== null) {
    return `its frontmatter shares a value with "${shared as string}", which cannot survive being re-written`;
  }
  const seen = new Set<string>();
  for (const pair of doc.contents.items) {
    if (!isScalar(pair.key)) {
      return "one of its keys is not a plain name";
    }
    const range = pair.key.range;
    if (!range) return "one of its keys cannot be located in the file";
    if (!atLineStart(text, range[0])) {
      return `the key "${text.slice(range[0], range[1]).trim()}" is indented, and re-writing the file would have to move it`;
    }
    const key = String(pair.key.value);
    if (seen.has(key)) {
      // Only OUR two keys matter: for anything else the duplicate rides along in
      // the extras exactly as written, so the file reads the same afterwards.
      if (key === "name" || key === "description") {
        return `it states "${key}" more than once, and readers disagree about which one wins`;
      }
    }
    seen.add(key);
  }
  return null;
}

/** One entry, spanning from `cursor` — the end of the previous one — so nothing
 * between two keys is lost. `null` for a key we cannot name, which
 * [`obstacleIn`] has already refused. */
function entryOf(pair: Pair, text: string, cursor: number): FrontmatterEntry | null {
  if (!isScalar(pair.key) || !pair.key.range) return null;
  const value = isScalar(pair.value) || pair.value === null ? pair.value : undefined;
  const valueRange = (pair.value as { range?: [number, number, number] } | null)?.range;
  // `range[2]` runs past a trailing comment; `range[1]` stops at the value. The
  // entry keeps the comment, the splice does not.
  const withComment = valueRange ? valueRange[2] : pair.key.range[2];
  const withoutComment = valueRange ? valueRange[1] : pair.key.range[1];
  // Two lengths, on purpose. `span` is what this entry CONSUMES, so the next
  // one's slice starts exactly where this stopped; `source` is what gets
  // re-emitted, with the previous line's own newline stripped off the front.
  const span = text.slice(cursor, withComment).replace(/\s+$/, "");
  const spliceText = text.slice(pair.key.range[0], withoutComment);
  const raw = value === undefined || value === null ? null : value.value;
  return {
    key: String(pair.key.value),
    span,
    // Folded onto one line: these two keys are single-line by contract, so what
    // has to survive a round trip is the MEANING of the value, not its layout.
    value: raw === null ? "" : normalizeSkillDescription(String(raw)).trim(),
    source: span.replace(/^[\r\n]+/, ""),
    splice:
      atLineStart(text, pair.key.range[0]) && !spliceText.includes("\n")
        ? { at: pair.key.range[0], text: spliceText }
        : null,
  };
}

const atLineStart = (text: string, at: number): boolean =>
  at === 0 || text[at - 1] === "\n";

/** Where the frontmatter sits inside the content: the fenced region's own text as
 * `[start, end)`, plus where the body begins after the closing fence.
 *
 * ONE home for "where does the frontmatter begin and end", because the reader and
 * [`renameSkillFile`]'s splice must agree on it. Tolerant of what real
 * frontmatter readers tolerate — CRLF, and trailing spaces on a fence, which are
 * invisible in an editor and used to demote the entire frontmatter into the body.
 * Anchored on an explicit `\n` rather than the `m` flag, whose `^` also matches
 * after a lone CR. */
function frontmatterSpan(
  content: string,
): { start: number; end: number; bodyAt: number } | null {
  // A leading BOM counts as part of the opening fence: readers that strip it — the
  // common JS ones — see the frontmatter, so answering "this file states no name"
  // moved the directory and left the file naming the old skill. (A re-compose
  // drops the BOM, which is a byte the format does not need.)
  const open = /^﻿?---[ \t]*\r?\n/.exec(content);
  if (!open) return null;
  const start = open[0].length;
  const close = /(?:^|(\n))---[ \t]*(?:\r?\n|$)/.exec(content.slice(start));
  if (!close) return null;
  const fenceAt = close.index + (close[1] ? 1 : 0);
  const fence = close[1] ? close[0].slice(1) : close[0];
  return { start, end: start + fenceAt, bodyAt: start + fenceAt + fence.length };
}

/** Quote a value only when YAML would misread it plain. Beyond the risky
 * characters, YAML's core schema turns bare `true`/`null`/`123`-style
 * scalars into booleans/numbers — real CLIs parse this frontmatter with
 * real YAML parsers, so those must be quoted to stay strings (our own
 * round-trip would never notice). */
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
