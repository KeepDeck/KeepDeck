import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * One rule: no cast that switches the type checker off.
 *
 * `x as unknown as T` makes anything a `T`; `x as never` makes anything fit
 * anywhere. In this codebase both were almost always a double built half-way
 * or a type too wide to fake, cast into place (task-433, task-467) — and a
 * member the code then started to use went missing from the double without
 * a word from the compiler. The fix is a narrower port or a whole typed
 * fake, never the cast. The build runs it (`build` starts with `eslint`), and
 * so does the test run (scripts/lint.test.mjs) — nobody has to remember to.
 */
export default [
  // Only the TypeScript this repo authors: built bundles, generated plugin
  // copies and plain JS are not what the rule is about.
  { ignores: ["**/*.{js,mjs,cjs}", "**/dist/**", "**/node_modules/**", "target/**", "src-tauri/**"] },
  {
    files: ["src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}", "plugins/*/src/**/*.{ts,tsx}"],
    languageOptions: { parser: tsParser },
    // Registered, not enabled: the source carries its directives, and an
    // unknown rule named in one is an error of its own.
    plugins: { "react-hooks": reactHooks },
    linterOptions: { reportUnusedDisableDirectives: "off" },
    rules: {
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
    },
  },
];
