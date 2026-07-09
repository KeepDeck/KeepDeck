/**
 * The Codex CLI plugin — data-only at this stage: identity and detection.
 * The spawn/resume hooks (the `-c` SessionStart overrides with their trusted
 * hash, the `resume` subcommand ordering) move in from the host's
 * domain/agents next.
 */
import type { KeepDeckPlugin } from "@keepdeck/plugin-api";

const plugin: KeepDeckPlugin = {
  activate(ctx) {
    ctx.agents.register({
      id: "codex",
      label: "Codex",
      detect: { bin: "codex" },
      hooks: {},
    });
  },
};

export default plugin;
