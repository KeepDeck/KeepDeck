/**
 * Terminal — pure logic around the xterm/PTY surface: key-event overrides,
 * copy/paste policy, resize-storm coalescing, dropped-path formatting, and
 * which input counts as answering an agent that is waiting on the user.
 * Everything is testable without xterm or the DOM; environment bindings are
 * injected by the caller.
 *
 * Link detection over (wrapped) buffer lines moved to @keepdeck/terminal-kit
 * alongside the xterm link provider that consumes it (`detectLinks`,
 * `logicalLineAt`, `mapRange` and friends now live there).
 */
export * from "./answers";
export * from "./clipboard";
export * from "./droppedPaths";
export * from "./keymap";
export * from "./refitPump";
