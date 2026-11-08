/**
 * The core files that may name a CLI. An entry is `{ file, names, count,
 * reason, until }`: the file says exactly `count` CLI names, all of them in
 * `names`. A new one fails; a removed one fails until `count` is lowered; an
 * entry whose file names no CLI fails until it is deleted. So this list only
 * shrinks. Nothing is added here to make a new leak pass: what a CLI needs
 * belongs in its plugin.
 *
 * `until: null` marks the one kind of entry that stays: a migration reading
 * or retiring what an older build wrote, where the name is a fact of that
 * old build.
 */
export const CLI_NAME_EXEMPTIONS = [
  // Frozen history: what an older build's files meant.
  { file: "src-tauri/src/plantings_migration.rs", names: ["kimi", "opencode"], count: 3, reason: "retires the MCP config and deletes the config homes builds before API 73 kept for these CLIs", until: null },
  { file: "src/domain/migrations/migrations.ts", names: ["claude"], count: 1, reason: "deck v13 → v14: a pane stored without an agent was claude's", until: null },
  { file: "crates/keepdeck-usage/src/legacy_migration.rs", names: ["claude", "anthropic", "codex", "openai", "opencode"], count: 10, reason: "usage store v2 → v3: reads the rows older builds booked in each agent's own convention (claude's display names, codex's input with its cache, opencode's reasoning beside output) back into maker model ids and canonical tokens", until: null },
];
