import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLI_NAME_EXEMPTIONS, CLI_NAMES, cliNamesIn, judge, REPO, words } from "./lint/cliNames.mjs";
import { rustWords } from "./lint/rustTokens.mjs";

/**
 * The core names no CLI (task-514). The TypeScript half is the ESLint rule
 * `keepdeck/no-cli-names` (scripts/lint.test.mjs runs it); this is the Rust
 * half and the exemption list itself, judged by the same module.
 */

/** Where the core's Rust lives; plugins have none. */
const RUST_ROOTS = ["src-tauri/src", "src-tauri/build.rs", ...readdirSync(join(REPO, "crates")).map((crate) => `crates/${crate}/src`)];
/** A test file: its CLI names are fixture ids. Test items inside a
 * production file are dropped by the lexer (`#[cfg(test)]`). */
const RUST_TEST_FILE = /(^|\/)(tests\/|tests\.rs$|[^/]*_tests\.rs$|test_support\.rs$)/;

function* rustFiles(path) {
  const full = join(REPO, path);
  if (!existsSync(full)) return;
  if (path.endsWith(".rs")) {
    if (!RUST_TEST_FILE.test(path)) yield path;
    return;
  }
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    if (entry.isDirectory() || entry.name.endsWith(".rs")) yield* rustFiles(`${path}/${entry.name}`);
  }
}

describe("CLI names in the core", () => {
  it("reads a name as a word, not a substring", () => {
    expect(CLI_NAMES).toEqual(new Set(["claude", "codex", "kimi", "opencode", "gemini", "aider", "copilot", "anthropic", "openai", "moonshot"]));
    for (const text of ["ClaudeHooks", "CODEX_HOME", "OpenCode", ".kimi/sessions", "claude-code", "codexAppServer", "fetchCodexRateLimits", "src/app/mcp/kimi.ts"]) {
      expect(cliNamesIn(text), text).toHaveLength(1);
    }
    for (const text of ["openFile", "encode", "codec", "Kimiko", "claudette", "precursor", "cursorPosition", "open code"]) {
      expect(cliNamesIn(text), text).toEqual([]);
    }
    expect(words("parseHTTPResponse codex_home")).toEqual(["parse", "http", "response", "codex", "home"]);
    expect(cliNamesIn("claude, codex, opencode")).toEqual(["claude", "codex", "opencode"]);
  });

  it("reads Rust's identifiers and strings, not its comments, chars or test items", () => {
    const source = [
      "// codex in a comment",
      "/* kimi /* nested */ claude */",
      "/// opencode in a doc",
      "fn spawn<'a>(x: &'a str) -> char { 'k' }",
      'const HOME: &str = r#"a "quoted" .kimi-code"#;',
      'const ESC: &str = "say \\"codex\\"";',
      "#[cfg(test)]",
      "fn helper() -> [u8; 2] { claude() }",
      "#[cfg(test)]",
      "#[allow(dead_code)]",
      "const FIXTURE: &str = \"opencode\";",
      "#[cfg(test)]",
      "mod tests { fn t() { let gemini = 1; } }",
      "pub fn codex_home() {}",
    ].join("\n");
    expect(rustWords(source).map(({ text, line }) => [line, text]).filter(([, text]) => cliNamesIn(text).length > 0)).toEqual([
      [5, 'a "quoted" .kimi-code'],
      [6, 'say \\"codex\\"'],
      [14, "codex_home"],
    ]);
  });

  it("holds an exempt file to its count and names, and drops a stale entry", () => {
    const [entry] = CLI_NAME_EXEMPTIONS;
    const hit = (names) => ({ at: 1, names });
    const exact = Array.from({ length: entry.count }, () => hit([entry.names[0]]));
    expect(judge(entry.file, exact, 0)).toEqual([]);
    expect(judge(entry.file, [...exact, hit([entry.names[0]])], 0).map(({ message }) => message)).toEqual([
      expect.stringContaining("the new one belongs in the CLI's plugin"),
    ]);
    expect(judge(entry.file, exact.slice(1), 0).map(({ message }) => message)).toEqual([
      expect.stringContaining(`lower its exemption from ${entry.count}`),
    ]);
    const foreign = [...CLI_NAMES].find((name) => !entry.names.includes(name));
    expect(judge(entry.file, [...exact.slice(1), hit([foreign])], 0).map(({ message }) => message)).toEqual([
      expect.stringContaining(`not ${foreign}`),
    ]);
    expect(judge(entry.file, [], 0)).toEqual([{ at: 0, message: expect.stringContaining("delete its exemption") }]);
    expect(judge("src/fresh.ts", [hit(["codex"]), hit(["kimi"])], 0).map(({ at }) => at)).toEqual([1, 1]);
    expect(judge("src/fresh.ts", [], 0)).toEqual([]);
  });

  it("lists each exemption once, for a file that exists, with a reason and the task it waits for", () => {
    const files = CLI_NAME_EXEMPTIONS.map((entry) => entry.file);
    expect(new Set(files).size).toBe(files.length);
    for (const entry of CLI_NAME_EXEMPTIONS) {
      expect(existsSync(join(REPO, entry.file)), entry.file).toBe(true);
      expect(entry.reason.length, entry.file).toBeGreaterThanOrEqual(10);
      expect(entry.until, entry.file).toMatch(/^task-\d+$/);
      expect(entry.count, entry.file).toBeGreaterThan(0);
      expect(entry.names.every((name) => CLI_NAMES.has(name)), entry.file).toBe(true);
    }
  });

  it("finds none in the core's Rust beyond the exemptions", () => {
    const problems = [];
    let read = 0;
    for (const root of RUST_ROOTS) {
      for (const file of rustFiles(root)) {
        read += 1;
        const hits = [];
        const path = cliNamesIn(file);
        if (path.length > 0) hits.push({ at: 0, names: path });
        for (const { text, line } of rustWords(readFileSync(join(REPO, file), "utf8"))) {
          const names = cliNamesIn(text);
          if (names.length > 0) hits.push({ at: line, names });
        }
        for (const { at, message } of judge(file, hits, 0)) problems.push(`${file}:${at}: ${message}`);
      }
    }
    // A run that read nothing proves nothing.
    expect(read).toBeGreaterThan(100);
    expect(problems).toEqual([]);
  });
});
