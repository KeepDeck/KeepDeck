import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_NAME_EXEMPTIONS } from "./cliNameExemptions.mjs";

/**
 * The core names no CLI (task-514, design task-505). A CLI's knowledge — its
 * name, its folders, its env, its quirks — lives in its plugin and reaches
 * the core through the plugin contract. This module is the one judge both
 * checks share: the ESLint rule `keepdeck/no-cli-names` for TypeScript, and
 * scripts/coreCliNames.test.mjs for Rust.
 *
 * It matches WORDS, not substrings: text is split at separators and at
 * camelCase boundaries, and a name is one word or two adjacent words joined
 * (`Open|Code`), not two words a separator parts (`open code`). So
 * `codexHome` and `.kimi-code` hit; `encode`, `codec` and `openFile` do not.
 *
 * Comments are not checked: they decide nothing, and many say why a thing
 * is generic now. Tests are not checked: their CLI names are fixture ids,
 * and a test of CLI behaviour goes with the production file that is caught.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Every agent a bundled plugin contributes — a new CLI plugin is covered
 * without touching the lint. */
function pluginAgentIds() {
  const ids = [];
  for (const entry of readdirSync(join(REPO, "plugins"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = JSON.parse(readFileSync(join(REPO, "plugins", entry.name, "manifest.json"), "utf8"));
    for (const agent of manifest.contributes?.agents ?? []) ids.push(agent.id);
  }
  return ids;
}

/** CLIs and vendors with no plugin yet. Not `cursor`: in the core that is
 * the text cursor. */
const UNPLUGGED = ["gemini", "aider", "copilot", "anthropic", "openai", "moonshot"];

export const CLI_NAMES = new Set([...pluginAgentIds(), ...UNPLUGGED]);

/** The words of each run between separators, a run split at its camelCase
 * boundaries: `fetchHTTPCodex x` → `[[fetch, http, codex], [x]]`.
 * @param {string} text */
function runs(text) {
  return text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((run) => run.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/).map((word) => word.toLowerCase()));
}

/** @param {string} text */
export function words(text) {
  return runs(text).flat();
}

/** The CLI names a piece of text says, one per occurrence. Two words of one
 * run make a name too (`OpenCode`); two words a separator parts do not
 * (`open code`).
 * @param {string} text */
export function cliNamesIn(text) {
  const found = [];
  for (const run of runs(text)) {
    for (let i = 0; i < run.length; i += 1) {
      if (CLI_NAMES.has(run[i])) found.push(run[i]);
      else if (i + 1 < run.length && CLI_NAMES.has(run[i] + run[i + 1])) {
        found.push(run[i] + run[i + 1]);
        i += 1;
      }
    }
  }
  return found;
}

/** A repo-relative path, `/`-separated.
 * @param {string} path */
export function repoPath(path) {
  return path.startsWith(REPO) ? path.slice(REPO.length + 1).split("\\").join("/") : path;
}

/**
 * What is wrong with one file, given where it says a CLI name. A file with
 * no exemption may say none: each place that does is reported. An exempt
 * file says exactly its listed count and only its listed names — fewer
 * means the entry is lowered (the list only shrinks), none means the entry
 * is deleted; those are reported once, at the first place.
 * @template T
 * @param {string} file repo-relative
 * @param {{ at: T, names: string[] }[]} hits
 * @param {T} top where a file-wide problem is reported
 * @returns {{ at: T, message: string }[]}
 */
export function judge(file, hits, top) {
  const exemption = CLI_NAME_EXEMPTIONS.find((entry) => entry.file === file);
  if (!exemption) {
    return hits.map(({ at, names }) => ({
      at,
      message: `The core names no CLI (${[...new Set(names)].join(", ")}): it belongs in the CLI's plugin.`,
    }));
  }
  const found = hits.flatMap((hit) => hit.names);
  const at = hits[0]?.at ?? top;
  if (found.length === 0) return [{ at, message: `${file} names no CLI any more: delete its exemption.` }];
  const problems = [];
  const foreign = [...new Set(found)].filter((name) => !exemption.names.includes(name));
  if (foreign.length > 0) {
    problems.push(`${file} is exempt for ${exemption.names.join(", ")}, not ${foreign.join(", ")}: that belongs in the CLI's plugin.`);
  }
  if (found.length > exemption.count) {
    problems.push(`${file} names a CLI ${found.length} times, its exemption ${exemption.count}: the new one belongs in the CLI's plugin.`);
  } else if (found.length < exemption.count) {
    problems.push(`${file} names a CLI ${found.length} times now: lower its exemption from ${exemption.count}.`);
  }
  return problems.map((message) => ({ at, message }));
}

export { CLI_NAME_EXEMPTIONS, REPO };
