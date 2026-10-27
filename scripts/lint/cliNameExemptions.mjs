/**
 * The core files that still name a CLI, each until the task that moves its
 * knowledge into the plugin (task-515's plan). An entry is `{ file, names,
 * count, reason, until }`: the file says exactly `count` CLI names, all of
 * them in `names`. A new one fails; a removed one fails until `count` is
 * lowered; an entry whose file names no CLI fails until it is deleted. So
 * this list only shrinks, and the task that empties a file deletes its
 * entry. Nothing is added here to make a new leak pass.
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

  // claude as the default agent.
  { file: "src/app/newAgentDefaults.ts", names: ["claude"], count: 1, reason: "claude is the default new agent", until: "task-526" },
  { file: "src/domain/agents/agents.ts", names: ["claude"], count: 1, reason: "claude is the default agent", until: "task-526" },
  { file: "src/domain/deck/panes/lifecycle.ts", names: ["claude"], count: 1, reason: "a pane without an agent is claude", until: "task-526" },
  { file: "src/domain/settings/codecs.ts", names: ["claude"], count: 1, reason: "settings default to claude", until: "task-526" },

  // Presentation the core holds per CLI.
  { file: "src/domain/usage/history/event.ts", names: ["claude"], count: 2, reason: "reads legacy usage records as claude", until: "task-527" },
  { file: "src/app/coreCommands/spawn.ts", names: ["claude", "codex", "opencode"], count: 6, reason: "tool descriptions list agent ids; built from the catalog", until: "task-528" },
  { file: "src/components/mcp/McpDialog.tsx", names: ["claude", "codex", "kimi", "opencode"], count: 4, reason: "hint lists the CLIs; built from the catalog", until: "task-528" },
  { file: "src/components/skills/SkillsDialog.tsx", names: ["claude", "codex", "kimi", "opencode"], count: 4, reason: "hint lists the CLIs; built from the catalog", until: "task-528" },
  { file: "src/components/settings/ExperimentalSection.tsx", names: ["codex", "opencode"], count: 2, reason: "hint lists the CLIs; built from the catalog", until: "task-528" },
  { file: "src/components/settings/McpServerRow.tsx", names: ["kimi"], count: 1, reason: "warning names kimi; goes with cwd arming", until: "task-530" },
];
