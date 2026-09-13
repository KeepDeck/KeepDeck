import { useState } from "react";
import {
  followRootSelection,
  initialRootSelection,
  type RootSelectionInput,
} from "./rootSelection";

/**
 * The root a dock tab shows, as React state reconciled every render through
 * [`followRootSelection`]: follows the highlight, holds a hand pick, leaves a
 * root that vanished. One hook for the three tabs that used to carry the
 * same seen-ref idiom each — the rule lives in `rootSelection`, this only
 * wires it to a component's lifetime.
 */
export function useRootSelection(
  input: RootSelectionInput,
): [target: string, pick: (target: string) => void] {
  const [state, setState] = useState(() => initialRootSelection(input));
  // Derived state reconciled in render: the pure rule answers with the same
  // object when nothing changed, which is what keeps this from looping.
  const next = followRootSelection(state, input);
  if (next !== state) setState(next);
  const pick = (target: string) => setState({ target, seenSelected: next.seenSelected });
  return [next.target, pick];
}
