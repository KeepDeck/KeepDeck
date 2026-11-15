/**
 * The letters a workspace's mark says — ONE home, read by every surface that
 * shows a mark: the strip, its drag ghost, the Workspaces window.
 *
 * The person's own letters (`Workspace.mark`) are theirs and are never
 * changed. Every other workspace gets letters worked out from its name,
 * unique across the deck: three workspaces called KeepDeck, KeepDeck Web and
 * KeepDeck promo used to be three "KD" marks nobody could tell apart. One
 * pass, in deck order — whoever comes first keeps the plain initials — over
 * EVERY workspace, archived ones included, so restoring one never changes
 * the letters of the rest.
 */
import type { Workspace } from "../domain/deck";

/** A name's words, as letters: split at spaces, dots, dashes, underscores
 * and slashes, and where a lower case letter meets an upper one; a word
 * with no letter or digit in it (an emoji) is not a word here. Characters
 * are taken whole — never half of one. */
function wordsOf(name: string): string[][] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s._\-/]+/)
    .map((word) => Array.from(word).filter((ch) => /[\p{L}\p{N}]/u.test(ch)))
    .filter((letters) => letters.length > 0);
}

/** The plain initials of a name: two words' first letters, else one word's
 * first two, case as typed ("web app" → "wa"); "?" for a name with none. */
export function workspaceInitials(name: string): string {
  return ladder(wordsOf(name))[0];
}

/** The letters a name may take, best first. The last rung, a digit after
 * the first letter, never runs out. */
function ladder(words: string[][]): string[] {
  const [first, second] = words;
  const last = words[words.length - 1];
  if (!first) return ["?"];
  const rungs =
    words.length >= 2
      ? [
          first[0] + second[0],
          first[0] + last[0],
          second.length > 1 ? first[0] + second[1] : null,
        ]
      : [
          first.slice(0, 2).join(""),
          first.length > 1 ? first[0] + first[first.length - 1] : null,
          first.length > 2 ? first[1] + first[first.length - 1] : null,
        ];
  return rungs.filter((rung): rung is string => rung !== null);
}

/** Every workspace's letters, by id: its own when the person chose them,
 * else the first rung of its name's ladder no workspace before it — and no
 * workspace's own letters — holds. */
export function workspaceMarks(workspaces: readonly Workspace[]): ReadonlyMap<string, string> {
  const taken = new Set(workspaces.flatMap((ws) => (ws.mark !== undefined ? [ws.mark] : [])));
  const marks = new Map<string, string>();
  for (const ws of workspaces) {
    if (ws.mark !== undefined) {
      marks.set(ws.id, ws.mark);
      continue;
    }
    const rungs = ladder(wordsOf(ws.name));
    let letters = rungs.find((rung) => !taken.has(rung));
    for (let n = 2; letters === undefined; n++) {
      const numbered = `${rungs[0] === "?" ? "?" : Array.from(rungs[0])[0]}${n}`;
      if (!taken.has(numbered)) letters = numbered;
    }
    taken.add(letters);
    marks.set(ws.id, letters);
  }
  return marks;
}
