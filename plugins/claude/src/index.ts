/**
 * The Claude Code CLI plugin — data-only at this stage: identity and
 * detection. The spawn/resume hooks (assigned `--session-id`, the
 * SessionStart reporter) move in from the host's domain/agents next.
 */
import type { KeepDeckPlugin } from "@keepdeck/plugin-api";

const plugin: KeepDeckPlugin = {
  activate(ctx) {
    ctx.agents.register({
      id: "claude",
      label: "Claude Code",
      detect: { bin: "claude" },
      hooks: {},
    });
  },
};

export default plugin;
