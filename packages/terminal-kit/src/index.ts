/**
 * @keepdeck/terminal-kit — the shared xterm surface kit.
 *
 * What lives here: the Cmd-click link provider (`registerTerminalLinks`), the
 * transient in-pane hint surface (`PaneHintView` + `useTransient`), and the
 * pure helpers behind link detection (`detectLinks`, `resolvePathTarget`,
 * `openErrorHint`, `logicalLineAt`, `mapRange`). Every xterm host in the app —
 * the agent panes, the Run log — draws from the same kit.
 *
 * Two deliberate design rules govern this package:
 *
 * 1. **IPC-inverted, transport-agnostic.** The link provider imports NO ipc:
 *    `TerminalLinkTarget` carries `openUrl`/`openPath`, injected by the
 *    consumer (the host binds its Tauri commands; a plugin binds its opener
 *    service; a test hands in `vi.fn()`s). So the kit has no dependency on the
 *    host's transport and drops cleanly into either tier.
 *
 * 2. **Import-map-agnostic — BUNDLED, not shared.** Unlike @keepdeck/plugin-api
 *    (which the runtime import map resolves to one shared host copy), this kit
 *    is bundled INTO each consumer at build time. Every consumer that depends
 *    on it ships its own copy inside its bundle; there is no runtime dedup and
 *    no import-map entry for it. That is intentional for this stage: the kit is
 *    small pure/UI code, and duplicating it costs far less than the machinery a
 *    shared runtime module would need.
 *
 * A note on styling: the moved views (`PaneHintView`) keep their original
 * classNames (`pane-hint`, …) and lean on the HOST stylesheet to provide them.
 * Built-in plugins ship WITH the app, so host CSS covering their UI is the
 * deliberate builtin-tier rule — a built-in surface is host chrome by another
 * name. An external-tier consumer would ship its own styles instead.
 */
export {
  detectLinks,
  openErrorHint,
  resolvePathTarget,
  type DetectedLink,
  type LinkKind,
} from "./links";
export {
  logicalLineAt,
  mapRange,
  MAX_LOGICAL_ROWS,
  type BufferRange,
  type LogicalLine,
  type WrappedBufferLike,
  type WrappedLineLike,
} from "./wrappedLines";
export {
  registerTerminalLinks,
  type TerminalLinkTarget,
} from "./terminalLinks";
export { HINT_MS, PaneHintView, type PaneHint } from "./PaneHint";
export { useTransient } from "./useTransient";
