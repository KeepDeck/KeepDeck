/**
 * Terminal — pure logic around the xterm/PTY surface: key-event overrides,
 * copy/paste policy, link detection over (wrapped) buffer lines, resize-storm
 * coalescing, and dropped-path formatting. Everything is testable without
 * xterm or the DOM; environment bindings are injected by the caller.
 */
export * from "./clipboard";
export * from "./droppedPaths";
export * from "./keymap";
export * from "./links";
export * from "./refitPump";
export * from "./wrappedLines";
