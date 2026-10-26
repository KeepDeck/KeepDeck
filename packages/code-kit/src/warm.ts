import { useEffect } from "react";
import { langFor } from "./lang";
import { warmLanguage } from "./highlighter";

/**
 * Warm-up: the highlighter's cold cost — the instance, and each grammar's
 * first compile (cpp ~650 ms, most well under 100) — paid in the highlight
 * worker while nobody waits, instead of as a plain-text pause on the first
 * file or diff a person opens. The main thread only sends messages; the
 * worker does the work in arrival order.
 */

/** The languages `paths` would be highlighted in, each once, in a stable
 * order. A path with no known language contributes nothing. */
export function langsToWarm(paths: readonly string[]): string[] {
  const langs = new Set<string>();
  for (const path of paths) {
    const lang = langFor(path);
    if (lang !== null) langs.add(lang);
  }
  return [...langs].sort();
}

/** Warm the instance, then each of `langs`. */
export function warmHighlighter(langs: readonly string[]): void {
  warmLanguage(null);
  for (const lang of langs) warmLanguage(lang);
}

/** Warm the highlighter for the files a surface shows. Re-runs only when the
 * SET of languages changes, not on every new path. */
export function useWarmHighlighter(paths: readonly string[]): void {
  const key = langsToWarm(paths).join("\n");
  useEffect(() => {
    warmHighlighter(key === "" ? [] : key.split("\n"));
  }, [key]);
}
