// The host's copy of "react/jsx-runtime", re-exported so plugin bundles
// compiled with the automatic JSX transform (`jsx`/`jsxs`/`Fragment` calls
// instead of hand-written `React.createElement`) resolve it to the HOST's
// runtime via the production import map (see index.html and vite.config.ts).
//
// Same reasoning as react.js: "react/jsx-runtime" is CJS underneath, and
// `export * from "..."` over the CJS interop was verified to yield no named
// ESM bindings at all in the built app. Destructuring the default import and
// re-exporting by hand gives real named exports every plugin bundle's JSX
// calls can bind to.
import ReactJsxRuntime from "react/jsx-runtime";

export const { Fragment, jsx, jsxs } = ReactJsxRuntime;
