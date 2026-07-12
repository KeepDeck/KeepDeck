import { useEffect, useState } from "react";
import { canHighlight } from "./limits";
import { tokenizeLines } from "./highlighter";
import type { LineTokens } from "./tokens";

/** What the hook holds: which (text, lang) the tokens belong to, so a render
 * with NEW text never shows the OLD text's colors (state updates lag a render
 * behind the props; the ownership check below closes that gap). */
interface Highlighted {
  text: string;
  lang: string;
  lines: LineTokens[];
}

/**
 * Progressive highlighting: returns null immediately (render plain — the
 * text is on screen without waiting for a grammar engine), then the per-line
 * tokens once tokenization lands, and the consumer re-renders in color.
 *
 * null stays forever when there's nothing to do: no language, text over the
 * limits (limits.ts), a language the kit didn't load, or a tokenizer failure
 * (logged, not thrown — color is decoration, the text already renders).
 *
 * Stale results are dropped twice over: a cancelled effect never commits its
 * result, and the returned value is cross-checked against the CURRENT props,
 * so even the committed state of a previous (text, lang) reads as null rather
 * than as the wrong file's colors.
 */
export function useHighlight(
  text: string | null,
  lang: string | null,
): LineTokens[] | null {
  const [state, setState] = useState<Highlighted | null>(null);

  useEffect(() => {
    if (text === null || lang === null || !canHighlight(text)) return;
    let cancelled = false;
    tokenizeLines(text, lang).then(
      (lines) => {
        if (!cancelled && lines) setState({ text, lang, lines });
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
  }, [text, lang]);

  return state !== null && state.text === text && state.lang === lang
    ? state.lines
    : null;
}
