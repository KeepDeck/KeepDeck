import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

/**
 * Attributes that turn off the browser/OS text-assist on a field — autocorrect,
 * autocapitalize, spellcheck, autocomplete. Spread onto every text input (and
 * textarea — the type is the intersection so both accept it): the app's fields
 * are paths, branch names, commands and identifiers where those "help" instead
 * by mangling input.
 */
export const noAutoCorrect: InputHTMLAttributes<HTMLInputElement> &
  TextareaHTMLAttributes<HTMLTextAreaElement> = {
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  autoComplete: "off",
};
