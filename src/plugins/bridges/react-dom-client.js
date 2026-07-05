// The host's copy of "react-dom/client", re-exported so a plugin that ever
// needs to mount its own root (rather than being rendered inside the host's
// tree) shares the host's react-dom instance via the production import map
// (see index.html and vite.config.ts) — two react-dom copies in one page
// double-render and corrupt each other's Fiber tree.
//
// Same reasoning as react.js: "react-dom/client" is CJS underneath, and
// `export * from "..."` over the CJS interop was verified to yield no named
// ESM bindings at all in the built app. Destructuring the default import and
// re-exporting by hand gives real named exports.
import ReactDOMClient from "react-dom/client";

export const { createRoot, hydrateRoot } = ReactDOMClient;
