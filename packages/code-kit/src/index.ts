/**
 * @keepdeck/code-kit — shared code rendering for the plugins that show code
 * (the Files preview, the Git diff). Path → language, a lazy Shiki singleton
 * behind a progressive React hook, and a per-line span renderer that drops
 * into the existing line-row markup.
 */
export { langFor } from "./lang";
export { canHighlight } from "./limits";
export { tokenizeLines } from "./highlighter";
export { useHighlight } from "./useHighlight";
export { TokenLine } from "./TokenLine";
export type { LineTokens, Token } from "./tokens";
