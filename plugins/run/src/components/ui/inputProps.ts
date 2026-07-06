import type { InputHTMLAttributes, TextareaHTMLAttributes } from "react";

/**
 * Attributes that turn off the browser/OS text-assist on a field — autocorrect,
 * autocapitalize, spellcheck, autocomplete. Spread onto every text input (and
 * textarea — the type is the intersection so both accept it): the panel's
 * fields are commands and names where those "help" instead by mangling input.
 *
 * Vendored from the host's src/ui because a built-in plugin bundles standalone
 * (it can't import host src/), and this stage adds no new npm deps.
 */
export const noAutoCorrect: InputHTMLAttributes<HTMLInputElement> &
  TextareaHTMLAttributes<HTMLTextAreaElement> = {
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  autoComplete: "off",
};
