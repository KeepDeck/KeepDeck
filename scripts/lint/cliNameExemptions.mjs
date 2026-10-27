/**
 * The core files that still name a CLI, each until the task that moves its
 * knowledge into the plugin (task-515's plan). An entry is `{ file, names,
 * count, reason, until }`: the file says exactly `count` CLI names, all of
 * them in `names`. A new one fails; a removed one fails until `count` is
 * lowered; an entry whose file names no CLI fails until it is deleted. So
 * this list only shrinks, and the task that empties a file deletes its
 * entry. Nothing is added here to make a new leak pass.
 *
 * `until: null` marks the one kind of entry that stays: a migration reading
 * what an older build wrote, where the name is a fact of that old file.
 */
export const CLI_NAME_EXEMPTIONS = [
  // The contract's per-CLI staging dirs; plugins build their own in their workspace dir.
  { file: "packages/plugin-api/src/context/agents.ts", names: ["claude", "opencode"], count: 2, reason: "claudePluginDir/opencodeConfigDir in the spawn context", until: "task-533" },
  { file: "src/app/spawnSpecs/plan.ts", names: ["claude", "opencode"], count: 2, reason: "fills claudePluginDir/opencodeConfigDir", until: "task-533" },
  { file: "src/app/worktrees/index.ts", names: ["claude", "opencode"], count: 2, reason: "fills claudePluginDir/opencodeConfigDir", until: "task-533" },
  { file: "src/ipc/skills.ts", names: ["claude", "opencode"], count: 2, reason: "the staged claude plugin and opencode config dirs", until: "task-533" },
  { file: "src/plugins/external/rpc/decode.ts", names: ["claude", "opencode"], count: 2, reason: "decodes claudePluginDir/opencodeConfigDir", until: "task-533" },
  { file: "src-tauri/src/skills/staging.rs", names: ["claude", "opencode"], count: 23, reason: "stages the claude plugin and opencode skill layouts", until: "task-533" },
  { file: "src-tauri/src/skills/opencode.rs", names: ["opencode"], count: 2, reason: "opencode's skill folder writer", until: "task-533" },
  { file: "src-tauri/src/skills/mod.rs", names: ["opencode"], count: 1, reason: "declares the opencode skill module", until: "task-533" },

  // kimi's MCP file, rendered and armed by the core.
  { file: "src/app/mcp/kimi.ts", names: ["kimi"], count: 6, reason: "renders kimi's .kimi-code/mcp.json", until: "task-532" },
  { file: "src/app/mcp/injection.ts", names: ["kimi"], count: 1, reason: "calls the kimi MCP renderer", until: "task-532" },
  { file: "src-tauri/src/mcp/arming.rs", names: ["kimi"], count: 8, reason: "arms kimi's MCP config dir", until: "task-533" },
  { file: "src-tauri/src/mcp/kimi.rs", names: ["kimi"], count: 2, reason: "kimi's MCP config writer", until: "task-533" },
  { file: "src-tauri/src/mcp/mod.rs", names: ["kimi"], count: 1, reason: "declares the kimi MCP module", until: "task-533" },

  // Frozen history: what an older build's files meant.
  { file: "src/domain/migrations/migrations.ts", names: ["claude"], count: 1, reason: "deck v13 → v14: a pane stored without an agent was claude's", until: null },
  { file: "src/domain/usage/history/migrateV1.ts", names: ["claude"], count: 1, reason: "usage schema 1: claude's v1 counters were not cumulative", until: null },

  // Presentation the core holds per CLI.
  { file: "src/components/settings/McpServerRow.tsx", names: ["kimi"], count: 1, reason: "warning names kimi; goes with cwd arming", until: "task-530" },
];
