import { cliNamesIn, judge, repoPath } from "./cliNames.mjs";

/**
 * `keepdeck/no-cli-names`: the core's TypeScript names no CLI — not in an
 * identifier, a string, a template, JSX, nor its own path. The judgement is
 * cliNames.mjs's, shared with the Rust check; comments and tests are out
 * (see there). Its own rule id, so it adds to every config block instead of
 * being replaced by a later block's `no-restricted-syntax`.
 */
export const noCliNames = {
  meta: {
    type: "problem",
    docs: { description: "The core names no CLI: a CLI's knowledge lives in its plugin." },
    schema: [],
  },
  create(context) {
    const file = repoPath(context.filename);
    /** @type {{ at: unknown, names: string[] }[]} */
    const hits = [];
    const path = cliNamesIn(file);
    if (path.length > 0) hits.push({ at: null, names: path });
    /** `import { a }` hands the same range over twice. */
    const seen = new Set();
    const read = (node, text) => {
      if (typeof text !== "string") return;
      const key = node.range.join(":");
      if (seen.has(key)) return;
      seen.add(key);
      const names = cliNamesIn(text);
      if (names.length > 0) hits.push({ at: node, names });
    };
    return {
      Identifier: (node) => read(node, node.name),
      PrivateIdentifier: (node) => read(node, node.name),
      JSXIdentifier: (node) => read(node, node.name),
      // A regex literal's value is a RegExp object; its pattern is the text.
      Literal: (node) => read(node, node.regex ? node.regex.pattern : node.value),
      TemplateElement: (node) => read(node, node.value.cooked ?? node.value.raw),
      JSXText: (node) => read(node, node.value),
      "Program:exit": (program) => {
        for (const { at, message } of judge(file, hits, program)) context.report({ node: at ?? program, message });
      },
    };
  },
};
