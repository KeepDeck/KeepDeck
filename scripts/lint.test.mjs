import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * Where each of the linter's rules holds.
 *
 * eslint.config.js refuses casts that switch the type checker off, explicit
 * `any`, TypeScript suppression comments, a component reaching past app's
 * hooks, and a CLI named in the core. `pnpm lint` holds the whole tree to
 * them, and `pnpm build` starts with it; these tests pin each rule to the
 * files it is for, on probes.
 *
 * The probes are linted without the type program: no rule they exercise
 * reads a type, and building that program cold costs seconds — on a busy
 * machine, far past a test's budget. The one type-aware rule is pinned
 * through the config instead.
 */
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A probe path in each tree eslint.config.js lints as TypeScript. */
const TYPESCRIPT_PROBES = [
  "src/lint-probe.ts",
  "packages/code-kit/src/lint-probe.ts",
  "plugins/opencode/src/lint-probe.ts",
  "integration/lint-probe.ts",
];

const eslint = new ESLint({
  cwd: REPO,
  overrideConfig: {
    languageOptions: { parserOptions: { projectService: false } },
    rules: { "@typescript-eslint/no-unsafe-type-assertion": "off" },
  },
});

describe("the linter", () => {
  it("catches suppressed checks in resource JS and explicit any in TypeScript", async () => {
    const [resource] = await eslint.lintText(
      "// @ts-check\n// @ts-ignore\nconst value = 1;\n",
      { filePath: join(REPO, "plugins/opencode/resources/keepdeck-plugin/lint-probe.js") },
    );
    const [typescript] = await eslint.lintText(
      "const value: any = 1;\n// @ts-expect-error\nvalue();\n",
      { filePath: join(REPO, "src/lint-probe.ts") },
    );
    expect(resource.messages.map((message) => message.ruleId)).toEqual([
      "@typescript-eslint/ban-ts-comment",
    ]);
    expect(typescript.messages.map((message) => message.ruleId)).toEqual([
      "@typescript-eslint/no-explicit-any",
      "@typescript-eslint/ban-ts-comment",
    ]);
  });

  it("turns the unchecked-assertion rule on, with its type program, in every TypeScript tree — the one rule that reads types", async () => {
    // How the rule reads a cast is typescript-eslint's to test; ours is that
    // it is on, with the types it needs, wherever casts are written. Being
    // the only type-aware rule is what lets every probe here lint untyped.
    const typed = new ESLint({ cwd: REPO });
    for (const file of TYPESCRIPT_PROBES) {
      const config = await typed.calculateConfigForFile(join(REPO, file));
      const typeAware = Object.entries(config.rules)
        .filter(([id, [severity]]) => {
          const at = id.lastIndexOf("/");
          const rule = at < 0 ? undefined : config.plugins[id.slice(0, at)]?.rules?.[id.slice(at + 1)];
          return severity > 0 && rule?.meta?.docs?.requiresTypeChecking === true;
        })
        .map(([id]) => id);
      expect(typeAware).toEqual(["@typescript-eslint/no-unsafe-type-assertion"]);
      expect(config.languageOptions.parserOptions.projectService).toBe(true);
    }
  });

  it("refuses `!`, the casts that switch the checker off, and broken hooks, in every TypeScript tree", async () => {
    const source = [
      'import { useEffect, useState } from "react";',
      "declare const maybe: string | null;",
      "export const sure: string = maybe!;",
      "export const never = 1 as never;",
      "const raw: unknown = 1;",
      "export const forced = raw as unknown as string;",
      "export function useProbe(on: boolean, value: number) {",
      "  if (on) useState(0);",
      "  useEffect(() => console.log(value), []);",
      "}",
      "",
    ].join("\n");
    for (const file of TYPESCRIPT_PROBES) {
      const [result] = await eslint.lintText(source, { filePath: join(REPO, file) });
      expect([file, result.messages.map((message) => [message.line, message.ruleId])]).toEqual([
        file,
        [
          [3, "@typescript-eslint/no-non-null-assertion"],
          [4, "no-restricted-syntax"],
          [6, "no-restricted-syntax"],
          [8, "react-hooks/rules-of-hooks"],
          [9, "react-hooks/exhaustive-deps"],
        ],
      ]);
    }
  });

  it("keeps a component to app's hooks, runtime context and types, and its test to app/testing besides", async () => {
    const source = [
      'import { updateSettings } from "../../app/settingsManager";',
      'import type { PluginCrash } from "../../app/pluginHealth";',
      'import { useSettings } from "../../app/useSettings";',
      'import { useReadyTasksBoard } from "../../app/tasks/useBoardState";',
      'import { useRuntimePart } from "../../app/runtimeContext";',
      'import { createUsageManager } from "../../app/testing";',
      "export const parts = [updateSettings, useSettings, useReadyTasksBoard, useRuntimePart, createUsageManager];",
      "export type Crash = PluginCrash;",
      "",
    ].join("\n");
    const [view] = await eslint.lintText(source, { filePath: join(REPO, "src/components/probe/LintProbe.tsx") });
    const [test] = await eslint.lintText(source, { filePath: join(REPO, "src/components/probe/LintProbe.test.tsx") });
    expect(view.messages.map((message) => [message.line, message.ruleId])).toEqual([
      [1, "@typescript-eslint/no-restricted-imports"],
      [6, "@typescript-eslint/no-restricted-imports"],
    ]);
    // A view test has one door more — app/testing — and no other.
    expect(test.messages.map((message) => [message.line, message.ruleId])).toEqual([
      [1, "@typescript-eslint/no-restricted-imports"],
    ]);
  });

  it("keeps presentation inward and gives production components IPC through ports", async () => {
    const [presentation] = await eslint.lintText(
      'import type { DeckStore } from "../app/deckStore";\nimport "../components/DeckStage";\nimport "../ipc/app";\nimport "../plugins/git/src/status";\n',
      { filePath: join(REPO, "src/presentation/lint-probe.ts") },
    );
    const [component] = await eslint.lintText(
      'import "../../ipc/app";\nimport "../../plugins/git/src/status";\n',
      { filePath: join(REPO, "src/components/dock/lint-probe.ts") },
    );
    const [componentTest] = await eslint.lintText(
      'import "../../ipc/app";\n',
      { filePath: join(REPO, "src/components/dock/lint-probe.test.ts") },
    );
    expect(presentation.messages.map((message) => message.ruleId)).toEqual(
      Array(4).fill("no-restricted-imports"),
    );
    expect(component.messages.map((message) => message.ruleId)).toEqual(
      Array(2).fill("no-restricted-imports"),
    );
    expect(componentTest.messages).toEqual([]);
  });

  it("checks every plugin resource JS with @ts-check", () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        const relative = path.slice(REPO.length + 1);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".js") && /^plugins\/[^/]+\/resources\//.test(relative)) {
          files.push(path);
        }
      }
    };
    walk(join(REPO, "plugins"));
    // A run that read nothing proves nothing.
    expect(files.length).toBeGreaterThan(20);
    const missing = files
      .filter((file) => !readFileSync(file, "utf8").split("\n").slice(0, 6).some((line) => line.trim() === "// @ts-check"))
      .map((file) => file.slice(REPO.length + 1));
    expect(missing).toEqual([]);
  });

  it("holds a component test's run-time loads to its surface too", async () => {
    const source = [
      'import { vi } from "vitest";',
      'vi.mock("../../app/settingsManager", () => ({}));',
      'vi.mock("../../app/useSettings", () => ({}));',
      'export const load = async () => [await import("../../app/settingsManager"), await import("../../app/testing")];',
      "",
    ].join("\n");
    const [test] = await eslint.lintText(source, { filePath: join(REPO, "src/components/probe/LintProbe.test.tsx") });
    expect(test.messages.map((message) => [message.line, message.ruleId])).toEqual([
      [2, "no-restricted-syntax"],
      [4, "no-restricted-syntax"],
    ]);
    // A production component has no app/testing door, at run time either.
    const [view] = await eslint.lintText(
      'export const load = async () => [await import("../../app/settingsManager"), await import("../../app/testing"), await import("../../app/useSettings")];\n',
      { filePath: join(REPO, "src/components/probe/LintProbe.tsx") },
    );
    expect(view.messages.filter((message) => message.ruleId === "no-restricted-syntax").length).toBe(2);
  });

  it("refuses a CLI named in the core, not in a plugin, a test or a comment", async () => {
    const leak = [
      "// codex in a comment decides nothing",
      'export const home = "CODEX_HOME";',
      "export const kimiDir = `${home}/.kimi-code`;",
      'export const encode = (codec: string) => "open code " + codec;',
      "export const tail = /\\.kimi-code\\//;",
      "",
    ].join("\n");
    const rule = (result) => result.messages.filter((message) => message.ruleId === "keepdeck/no-cli-names");
    const [src] = await eslint.lintText(leak, { filePath: join(REPO, "src/lint-probe.ts") });
    expect(rule(src).map((message) => message.line)).toEqual([2, 3, 3, 5]);
    // A block that redefines no-restricted-syntax does not drop it.
    const [component] = await eslint.lintText(leak, { filePath: join(REPO, "src/components/dock/lint-probe.ts") });
    expect(rule(component)).toHaveLength(4);
    const [plugin] = await eslint.lintText(leak, { filePath: join(REPO, "plugins/opencode/src/lint-probe.ts") });
    const [test] = await eslint.lintText(leak, { filePath: join(REPO, "src/components/dock/lint-probe.test.ts") });
    expect([rule(plugin), rule(test)]).toEqual([[], []]);
  });

  it("holds an exempt file to its listed count and drops a stale exemption", async () => {
    // The deck migration is exempt for the one claude it names, for good.
    const filePath = join(REPO, "src/domain/migrations/migrations.ts");
    const source = readFileSync(filePath, "utf8");
    const messages = async (text) =>
      (await eslint.lintText(text, { filePath }))[0].messages
        .filter((message) => message.ruleId === "keepdeck/no-cli-names")
        .map((message) => message.message);
    expect(await messages(source)).toEqual([]);
    expect(await messages(`${source}\nexport const more = "claude";\n`)).toEqual([
      expect.stringContaining("the new one belongs in the CLI's plugin"),
    ]);
    expect(await messages(`${source}\nexport const other = "codex";\n`)).toEqual([
      expect.stringContaining("not codex"),
      expect.stringContaining("the new one belongs in the CLI's plugin"),
    ]);
    expect(await messages("export const nothing = 1;\n")).toEqual([expect.stringContaining("delete its exemption")]);
  });
});
