/**
 * Every test runs with React's act() in charge of its updates — the flag
 * React 19 reads outside a test-framework integration. Set ONCE here (the
 * vitest setup file, vite.config.ts) and typed, where each test file used to
 * set it for itself through a cast of `globalThis`.
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

export {};
