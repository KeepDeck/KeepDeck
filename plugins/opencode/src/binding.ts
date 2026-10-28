import type { AgentBinding } from "@keepdeck/plugin-api";

/**
 * opencode's words for a session that continues the pane, as its pane
 * reporter states them (resources/keepdeck-plugin/pane-report.js): the pane
 * switched to an old session (`resume`) or started a new one in place
 * (`new`). Its first session is `startup`.
 */
export const opencodeBinding = {
  swapSources: ["resume", "new"],
} satisfies AgentBinding;
