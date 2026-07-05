// The host's copy of "@keepdeck/plugin-api", re-exported so a plugin bundle
// built with the package marked external resolves it to the HOST's instance
// via the production import map (see index.html and vite.config.ts) — the
// package holds no state of its own, but a plugin comparing e.g. `API_VERSION`
// or calling `readManifest` must see the exact code the host shipped with.
//
// UNLIKE react.js / react-jsx-runtime.js / react-dom-client.js, this one is a
// plain `export *`: those bridges hand-list names because "react" and
// "react-dom/client" are CJS underneath, and Rollup's CJS→ESM interop cannot
// statically discover named exports on a `module.exports` object assigned at
// runtime (verified: `export *` over that interop yields zero bindings).
// "@keepdeck/plugin-api" is genuine ESM TypeScript source — Rollup reads its
// static `export`/`export type` statements directly, so `export *` here
// forwards every real (non-type, erased-at-compile-time) binding correctly.
export * from "@keepdeck/plugin-api";
