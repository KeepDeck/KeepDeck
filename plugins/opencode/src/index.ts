/**
 * The OpenCode CLI plugin — data-only at this stage: identity and detection.
 * The spawn/resume hooks (the session-reporter plugin injected via
 * `OPENCODE_CONFIG_CONTENT`, the `-s` resume flag) move in from the host's
 * domain/agents next.
 */
import type { KeepDeckPlugin } from "@keepdeck/plugin-api";

const plugin: KeepDeckPlugin = {
  activate(ctx) {
    ctx.agents.register({
      id: "opencode",
      label: "OpenCode",
      detect: { bin: "opencode" },
      hooks: {},
    });
  },
};

export default plugin;
