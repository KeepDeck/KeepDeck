import type { AgentBinding } from "@keepdeck/plugin-api";

/**
 * claude's words for a session that continues the pane's conversation — its
 * SessionStart sources (hook reference): resumed, cleared, compacted,
 * forked. A second `startup` from the same process is an in-process
 * teammate, which the deck refuses; claude has no restart to tell it apart
 * from, so it declares no callback.
 */
export const claudeBinding = {
  swapSources: ["resume", "clear", "compact", "fork"],
} satisfies AgentBinding;
