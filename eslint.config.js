import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * The patterns this codebase refuses, as rules that fail the build (`build`
 * starts with `eslint`) and the test run (scripts/lint.test.mjs) — nobody
 * has to remember to run them. Each rule here is a decision made once; the
 * code that broke it was fixed, not excused (task-468).
 */

const TYPESCRIPT = [
  "src/**/*.{ts,tsx}",
  "packages/*/src/**/*.{ts,tsx}",
  "plugins/*/src/**/*.{ts,tsx}",
  "integration/**/*.{ts,tsx}",
];
const TESTS = ["**/*.test.{ts,tsx}", "**/*.test-support.{ts,tsx}", "**/*testSupport.{ts,tsx}"];

/** Import patterns more than one block refuses. A later block's
 * `no-restricted-imports` replaces an earlier one's for the files both
 * match, so each block lists every pattern that holds for its files. */
const NO_PLUGIN = {
  regex: "(^|/)plugins/[^/]+/src(/|$)",
  message: "The core imports no plugin: go through the plugin contract.",
};
const NO_INTEGRATION = {
  regex: "(^|/)integration(/|$)",
  message: "Nothing imports from integration/: it is tests, and only tests.",
};

export default [
  // Only the TypeScript this repo authors: built bundles, generated plugin
  // copies and plain JS are not what these rules are about.
  { ignores: ["**/*.{js,mjs,cjs}", "**/dist/**", "**/node_modules/**", "target/**", "src-tauri/**"] },

  {
    files: TYPESCRIPT,
    languageOptions: { parser: tsParser },
    plugins: { "react-hooks": reactHooks },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
      /**
       * No cast that switches the type checker off. `x as unknown as T`
       * makes anything a `T`; `x as never` makes anything fit anywhere. They
       * were almost always a double built half-way or a type too wide to
       * fake, cast into place (task-433, task-467) — and a member the code
       * then started to use went missing from the double without a word
       * from the compiler. The fix is a narrower port or a whole typed fake.
       */
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSAsExpression > TSNeverKeyword, TSTypeAssertion > TSNeverKeyword",
          message: "`as never` switches the type checker off: fix the type, not the cast.",
        },
        {
          selector:
            "TSAsExpression > TSAsExpression.expression > TSUnknownKeyword.typeAnnotation, TSTypeAssertion > TSAsExpression.expression > TSUnknownKeyword.typeAnnotation",
          message: "`as unknown as` switches the type checker off: fix the type, not the cast.",
        },
      ],
      // A hook called conditionally or outside a component breaks React's
      // own bookkeeping; nothing here does it, and nothing will.
      "react-hooks/rules-of-hooks": "error",
    },
  },

  /**
   * integration/ is the one place the host and a real plugin meet: a test
   * there proves the two sides compose (a plugin's real normalizer driving
   * the real tracker, a plugin's history read by the real scan), and may
   * import both. It is a leaf — packages and plugins import nothing from
   * it, and neither does the core, tests included.
   */
  {
    files: ["src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}", "plugins/*/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [NO_INTEGRATION] }],
    },
  },

  /**
   * The core names no plugin: a CLI's knowledge lives in its plugin, reached
   * through the plugin contract. Tests may pair the host with a real plugin
   * to prove the contract end to end.
   */
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: TESTS,
    rules: {
      "no-restricted-imports": ["error", { patterns: [NO_PLUGIN, NO_INTEGRATION] }],
    },
  },

  /**
   * The domain knows nothing of how it is shown, stored or carried: no
   * React, no Tauri, no IPC, no app wiring, no presentation or component —
   * dependencies point inward (the project's design rules). After the core
   * block: a later block's rule replaces an earlier one's, so this one
   * carries the core's pattern too.
   */
  {
    files: ["src/domain/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^(react|react-dom)(/|$)|^@tauri-apps/",
              message: "The domain is framework-free: no React, no Tauri.",
            },
            {
              regex: "(^|/)(app|ipc|components|presentation)(/|$)",
              message: "The domain depends on nothing outside it: no app wiring, IPC, components or presentation.",
            },
            NO_PLUGIN,
            NO_INTEGRATION,
          ],
        },
      ],
    },
  },
];
