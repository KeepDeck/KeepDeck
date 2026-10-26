import { useEffect, useMemo, useState } from "react";
import { canHighlight } from "./limits";
import { tokenizeLines } from "./highlighter";
import type { LineTokens } from "./tokens";

/** What the hook holds: which (texts, lang) the tokens belong to, so a render
 * with NEW texts never shows the OLD texts' colors (state updates lag a render
 * behind the props; the ownership check below closes that gap). */
interface Highlighted {
  texts: readonly string[];
  lang: string;
  docs: LineTokens[][];
}

/** Same texts by value, in the same order. */
function sameTexts(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((text, i) => text === b[i]);
}

/** The texts as one value the effect can key on. NUL never occurs in a text
 * worth highlighting — the host reads such content as binary. */
const SEPARATOR = "\u0000";

/**
 * Progressive highlighting of several documents in one language — a diff's
 * two sides, its hunks: returns null immediately (render plain — the text is
 * on screen without waiting for a grammar engine), then each document's
 * per-line tokens once every one has landed, and the consumer re-renders in
 * color.
 *
 * All or nothing, like `canHighlight`: null stays forever when there's
 * nothing to do — no language, a document over the limits (limits.ts), a
 * language the kit didn't load, or a tokenizer failure (logged, not thrown —
 * color is decoration, the text already renders). Half a view in color reads
 * as a rendering bug.
 *
 * Stale results are dropped twice over: a cancelled effect never commits its
 * result, and the returned value is cross-checked against the CURRENT props,
 * so even the committed state of previous texts reads as null rather than as
 * the wrong file's colors. Texts compare by value: a rebuilt array never
 * re-triggers tokenization, though a stable one (memoized by the caller) also
 * spares the join that tells.
 */
export function useHighlights(
  texts: readonly string[] | null,
  lang: string | null,
): LineTokens[][] | null {
  const [state, setState] = useState<Highlighted | null>(null);
  // No documents is nothing to do, like no text. Joined once per array, not
  // per render: a diff's sides can be a megabyte each.
  const key = useMemo(
    () => (texts === null || texts.length === 0 ? null : texts.join(SEPARATOR)),
    [texts],
  );

  useEffect(() => {
    if (key === null || lang === null) return;
    const docTexts = key.split(SEPARATOR);
    if (!docTexts.every(canHighlight)) return;
    let cancelled = false;
    Promise.all(docTexts.map((text) => tokenizeLines(text, lang))).then(
      (docs) => {
        const lines = docs.filter((doc) => doc !== null);
        if (cancelled || lines.length !== docs.length) return;
        setState({ texts: docTexts, lang, docs: lines });
      },
      (cause: unknown) => {
        if (!cancelled) {
          console.warn(`code-kit: highlighting ${lang} failed:`, cause);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, lang]);

  return state !== null && texts !== null && state.lang === lang && sameTexts(state.texts, texts)
    ? state.docs
    : null;
}

/** One document: `useHighlights` for a single text. */
export function useHighlight(
  text: string | null,
  lang: string | null,
): LineTokens[] | null {
  const texts = useMemo(() => (text === null ? null : [text]), [text]);
  const docs = useHighlights(texts, lang);
  return docs?.[0] ?? null;
}
