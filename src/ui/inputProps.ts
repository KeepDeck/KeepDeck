import type { InputHTMLAttributes } from "react";

/**
 * Attributes that turn off the browser/OS text-assist on a field — autocorrect,
 * autocapitalize, spellcheck, autocomplete. Spread onto every text input: the
 * app's fields are paths, branch names, and identifiers where those "help"
 * instead by mangling input.
 */
export const noAutoCorrect: InputHTMLAttributes<HTMLInputElement> = {
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  autoComplete: "off",
};
