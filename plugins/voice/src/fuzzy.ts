/**
 * Fuzzy name resolution — the bridge between what STT heard and the real
 * workspace/agent names. Deliberately conservative: a confident unique best
 * match or nothing; a tie or a weak match returns null and the command is
 * refused with the transcript shown, never executed against a guess.
 */
function canon(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Spaces dropped entirely — "web site" and "Website" are the same thing. */
function packed(text: string): string {
  return canon(text).replace(/ /g, "");
}

function score(candidate: string, spoken: string): number {
  const c = canon(candidate);
  const s = canon(spoken);
  if (!c || !s) return 0;
  if (c === s || packed(candidate) === packed(spoken)) return 100;
  // Spoken references inflect and trail off ("кипдеке", "keepdeck workspace")
  // — a prefix either way is a strong signal.
  if (packed(candidate).startsWith(packed(spoken)) || packed(spoken).startsWith(packed(candidate)))
    return 80;
  if (packed(candidate).includes(packed(spoken)) || packed(spoken).includes(packed(candidate)))
    return 60;
  // Token overlap for multi-word names.
  const ct = new Set(c.split(" "));
  const st = s.split(" ");
  const hit = st.filter((t) => ct.has(t)).length;
  return hit > 0 ? Math.round((hit / Math.max(ct.size, st.length)) * 40) : 0;
}

const FLOOR = 40;

/** The unique best candidate for `spoken`, or null (unknown or ambiguous). */
export function bestMatch(candidates: string[], spoken: string): string | null {
  let best: string | null = null;
  let bestScore = 0;
  let tied = false;
  for (const candidate of candidates) {
    const s = score(candidate, spoken);
    if (s > bestScore) {
      best = candidate;
      bestScore = s;
      tied = false;
    } else if (s === bestScore && s > 0 && candidate !== best) {
      tied = true;
    }
  }
  if (bestScore < FLOOR || tied) return null;
  return best;
}
