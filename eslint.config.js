import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
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
const NO_PRESENTATION_OUTWARD = {
  regex: "(^|/)(app|components|ipc)(/|$)",
  message: "Presentation reads domain and its own ports, not app wiring, components or IPC.",
};
const NO_COMPONENTS_IPC = {
  regex: "(^|/)ipc(/|$)",
  message: "Components receive native capabilities through app ports, not IPC imports.",
};
const COMPONENT_TESTS = [
  "**/*.test.{ts,tsx}",
  "**/*.test-support.{ts,tsx}",
  "**/*testSupport.{ts,tsx}",
  "**/*TestSupport.{ts,tsx}",
  "**/*.fake.{ts,tsx}",
];
const RESOURCE_JS = ["plugins/*/resources/**/*.js"];
const BAN_TS_COMMENT = ["error", { "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true, "ts-check": false }];

/**
 * What a production component may take from src/app: a hook (a module named
 * `use*`, at any depth) and the runtime context — the app's public surface
 * for views — plus any type. Everything else in app is wiring a view reaches
 * through one of those.
 */
const COMPONENTS_APP_SURFACE = {
  regex: "(^|/)app/(?!(.*/)?(use[A-Z][^/]*|runtimeContext)$)",
  caseSensitive: true,
  allowTypeImports: true,
  message: "A component reaches app only through a hook (app/**/use*) or runtimeContext; types are free.",
};
/** A component test's one extra door: app/testing, the app as a view test
 * assembles it (task-483). */
const COMPONENT_TESTS_APP_SURFACE = {
  ...COMPONENTS_APP_SURFACE,
  regex: "(^|/)app/(?!(.*/)?(use[A-Z][^/]*|runtimeContext)$|testing$)",
  message: "A component test reaches app through its hooks, runtimeContext, or app/testing; types are free.",
};
const TEST_FILES = ["**/*.test.{ts,tsx}", "**/*.test-support.{ts,tsx}", "**/*[tT]estSupport.{ts,tsx}"];

/** The casts that switch the type checker off — shared because a later
 * block's `no-restricted-syntax` replaces an earlier one's for its files. */
const CAST_BANS = [
  {
    selector: "TSAsExpression > TSNeverKeyword, TSTypeAssertion > TSNeverKeyword",
    message: "`as never` switches the type checker off: fix the type, not the cast.",
  },
  {
    selector:
      "TSAsExpression > TSAsExpression.expression > TSUnknownKeyword.typeAnnotation, TSTypeAssertion > TSAsExpression.expression > TSUnknownKeyword.typeAnnotation",
    message: "`as unknown as` switches the type checker off: fix the type, not the cast.",
  },
];

/** What a component test may load at run time — a dynamic import, a module
 * it mocks — held to the same surface as its static imports. The import
 * rule reads only static imports; vi.mock factories load through import(). */
const APP_OUTSIDE_TEST_SURFACE =
  "/(^|\\/)app\\/(?!(.*\\/)?(use[A-Z][^\\/]*|runtimeContext|runtimeContext\\.test-support)$|testing$)/";
/** The same for a production component, whose surface has no app/testing. */
const APP_OUTSIDE_VIEW_SURFACE = "/(^|\\/)app\\/(?!(.*\\/)?(use[A-Z][^\\/]*|runtimeContext)$)/";
const COMPONENT_RUNTIME_SURFACE = [
  {
    selector: `ImportExpression > Literal.source[value=${APP_OUTSIDE_VIEW_SURFACE}]`,
    message: "A component loads app through its hooks or runtimeContext — at run time too.",
  },
];
const COMPONENT_TEST_RUNTIME_SURFACE = [
  {
    selector: `ImportExpression > Literal.source[value=${APP_OUTSIDE_TEST_SURFACE}]`,
    message: "A component test loads app through its hooks, runtimeContext or app/testing — at run time too.",
  },
  {
    selector: `CallExpression[callee.object.name="vi"][callee.property.name=/^(mock|doMock)$/] > Literal.arguments:first-child[value=${APP_OUTSIDE_TEST_SURFACE}]`,
    message: "A component test mocks app's hooks or runtimeContext, never a module behind them.",
  },
];

export default [
  // Only the TypeScript this repo authors: built bundles, generated plugin
  // copies and plain JS outside plugin resources are not what these rules are about.
  { ignores: ["**/*.{mjs,cjs}", "**/dist/**", "**/node_modules/**", "target/**", "src-tauri/**"] },

  {
    files: [...TYPESCRIPT, ...RESOURCE_JS],
    languageOptions: { parser: tsParser },
    plugins: { "@typescript-eslint": tsPlugin },
    linterOptions: { noInlineConfig: true },
    rules: {
      // A dynamic boundary gets `unknown` and a guard; `any` silently turns
      // off checking for every operation that follows it.
      "@typescript-eslint/no-explicit-any": "error",
      // Resource JS uses @ts-check to verify its JSDoc. Suppressions would
      // hide mistakes there as surely as they do in TypeScript.
      "@typescript-eslint/ban-ts-comment": BAN_TS_COMMENT,
      // `x!` tells only the compiler that a value is there. A value the code
      // relies on is made present by its type, a guard that fails by name,
      // or in a test by present() from @keepdeck/plugin-api/testing
      // (task-474).
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },

  {
    files: TYPESCRIPT,
    languageOptions: { parser: tsParser },
    plugins: { "react-hooks": reactHooks },
    linterOptions: {
      // A comment that disables a rule is not a way to pass the lint
      // (task-468): the code is fixed, the rule stays on.
      noInlineConfig: true,
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      /**
       * No cast that switches the type checker off. `x as unknown as T`
       * makes anything a `T`; `x as never` makes anything fit anywhere. They
       * were almost always a double built half-way or a type too wide to
       * fake, cast into place (task-433, task-467) — and a member the code
       * then started to use went missing from the double without a word
       * from the compiler. The fix is a narrower port or a whole typed fake.
       */
      "no-restricted-syntax": ["error", ...CAST_BANS],
      // A hook called conditionally or outside a component breaks React's
      // own bookkeeping; nothing here does it, and nothing will.
      "react-hooks/rules-of-hooks": "error",
      // Every effect names what it reads, or keeps the value in a ref when
      // the trigger is deliberately narrower (task-471). No suppressions:
      // `noInlineConfig` above refuses them.
      "react-hooks/exhaustive-deps": "error",
    },
  },

  /**
   * integration/ is the one place the host and a real plugin meet: a test
   * there proves the two sides compose (a plugin's real normalizer driving
   * the real tracker, a plugin's history read by the real scan), and may
   * import both. It is a leaf — packages and plugins import nothing from
   * it, and neither does the core (below).
   */
  {
    files: ["packages/*/src/**/*.{ts,tsx}", "plugins/*/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [NO_INTEGRATION] }],
    },
  },

  /**
   * The core names no plugin: a CLI's knowledge lives in its plugin, reached
   * through the plugin contract. No exception for tests: a core test that
   * needs what a plugin would hand it builds a typed fake through
   * @keepdeck/plugin-api; a test proving the host and a real plugin compose
   * belongs in integration/.
   */
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [NO_PLUGIN, NO_INTEGRATION] }],
    },
  },

  /** Presentation owns pure view policy and port shapes. Its tests follow
   * the same dependency direction, using domain fixtures and port fakes. */
  {
    files: ["src/presentation/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [NO_PRESENTATION_OUTWARD, NO_PLUGIN, NO_INTEGRATION] }],
    },
  },

  /** A component test may assemble the app and IPC doubles for the view it
   * exercises. Production components receive native capabilities as ports. */
  {
    files: ["src/components/**/*.{ts,tsx}"],
    ignores: COMPONENT_TESTS,
    rules: {
      "no-restricted-imports": ["error", { patterns: [NO_COMPONENTS_IPC, NO_PLUGIN, NO_INTEGRATION] }],
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

  /**
   * Components are views: they read and act through hooks and the runtime's
   * parts, never through the app's managers and services directly (task-472).
   * The typed rule, so a type-only import passes — and a rule id of its own,
   * so it adds to the core `no-restricted-imports` blocks above rather than
   * replacing them for these files. A view test holds to the same surface
   * plus one door, app/testing: the real parts it builds, the singletons it
   * seeds, the doubles and the port stand-ins — never a manager reached
   * around the hooks.
   */
  {
    files: ["src/components/**/*.{ts,tsx}"],
    ignores: TEST_FILES,
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [COMPONENTS_APP_SURFACE] }],
      "no-restricted-syntax": ["error", ...CAST_BANS, ...COMPONENT_RUNTIME_SURFACE],
    },
  },
  {
    files: TEST_FILES.map((pattern) => `src/components/${pattern}`),
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [COMPONENT_TESTS_APP_SURFACE] }],
      "no-restricted-syntax": ["error", ...CAST_BANS, ...COMPONENT_TEST_RUNTIME_SURFACE],
    },
  },
];
