// The host's copy of "react", re-exported for plugin bundles to resolve
// against via the production import map (see index.html and vite.config.ts).
//
// WHY explicit named re-exports instead of `export * from "react"`: react
// ships CJS, and Vite/Rollup's commonjs interop only synthesizes named ESM
// bindings for keys it can statically discover on the module's default
// export. A live spike against the built app (tauri://localhost, WKWebView)
// proved `export * from "react"` here produces ZERO named bindings — every
// plugin `import { useState } from "react"` fails with "Importing binding
// name 'useState' is not found". Destructuring the default import and
// re-exporting each name by hand sidesteps the interop entirely: this file
// becomes the one place doing CJS→ESM translation, and everything importing
// "react" downstream (this bridge's own build, and every plugin bundle via
// the import map) sees plain, real ESM named exports.
//
// Surface: the full stable React 19 API. Anything new React ships needs a
// line added here before a plugin can use it.
import React from "react";

export default React;

export const {
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  act,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version,
} = React;
