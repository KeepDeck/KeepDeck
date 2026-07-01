/**
 * Detect clickable links in a line of terminal output — http(s) URLs ([F14]) and
 * file paths ([F10]) — for an xterm link provider. Pure (string in, ranges out)
 * so detection is unit-testable without xterm.
 *
 * Detection is deliberately conservative to limit false positives: a "path" must
 * either be absolute / `./` / `../` / `~/`-prefixed, or be a multi-segment path
 * ending in a `.ext`. Plain words and `and/or`-style tokens are ignored. Paths
 * may carry a trailing `:line(:col)` (kept in the clickable range, stripped when
 * opening). No spaces inside paths.
 */
export type LinkKind = "url" | "path";

export interface DetectedLink {
  /** 0-based char offset where the link starts in the line. */
  start: number;
  /** 0-based char offset one past the link's end. */
  end: number;
  kind: LinkKind;
  /** The matched text (path links keep their `:line:col`). */
  text: string;
}

const URL_RE = /\bhttps?:\/\/[^\s'"`<>()[\]{}]+/g;

const LINE_COL = "(?::\\d+(?::\\d+)?)?";
// Absolute or ./ ../ ~/-prefixed path: a leading slash then ≥1 segment (no
// extension required — absolute paths often have none).
const ABS = "(?:~|\\.\\.?)?\\/(?:[\\w.@%+\\-]+\\/)*[\\w.@%+\\-]+";
// Relative path ending in a file with an extension: seg/…/name.ext (segments
// carry no dots so `and/or` and `n/a` aren't matched).
const REL_EXT = "(?:[\\w@%+\\-]+\\/)+[\\w@%+\\-]+(?:\\.[\\w@%+\\-]+)+";
// A leading boundary so a path isn't matched mid-token — e.g. the `/a` inside
// `n/a`, or a path glued onto a preceding word/path character.
const BOUNDARY = "(?<![\\w@%+./~-])";
const PATH_RE = new RegExp(`${BOUNDARY}(?:${ABS}|${REL_EXT})${LINE_COL}`, "g");

/** Trailing punctuation that's almost always sentence/markup, not part of a URL. */
function trimTrailingPunct(s: string): string {
  return s.replace(/[.,;:!?)\]}'"]+$/, "");
}

export function detectLinks(line: string): DetectedLink[] {
  const links: DetectedLink[] = [];

  for (const m of line.matchAll(URL_RE)) {
    const text = trimTrailingPunct(m[0]);
    if (text) {
      links.push({ start: m.index, end: m.index + text.length, kind: "url", text });
    }
  }

  for (const m of line.matchAll(PATH_RE)) {
    const start = m.index;
    const end = start + m[0].length;
    // Skip a path that overlaps a URL we already matched (URL path components).
    if (links.some((l) => start < l.end && end > l.start)) continue;
    links.push({ start, end, kind: "path", text: m[0] });
  }

  return links.sort((a, b) => a.start - b.start);
}

/**
 * Turn a matched path link into an absolute path to open: strip a trailing
 * `:line(:col)`, and resolve a relative path against the pane's `cwd`. Absolute
 * and `~`-paths are returned as-is (the backend expands `~`).
 */
export function resolvePathTarget(text: string, cwd: string): string {
  const path = text.replace(/:\d+(?::\d+)?$/, "");
  if (path.startsWith("/") || path.startsWith("~")) return path;
  return `${cwd.replace(/\/+$/, "")}/${path}`;
}
