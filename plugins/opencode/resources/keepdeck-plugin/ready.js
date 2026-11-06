// @ts-check
/**
 * The pane's agent is at its prompt — said once, as this plugin starts.
 *
 * opencode states nothing of its own before a conversation exists, and the
 * full TUI makes one only with the first prompt: measured on 1.19.3, the
 * plugin loads and then the bus stays silent for as long as the home screen
 * stands, and a resumed session is no different (task-617). The plugin
 * loading is the moment the process is up and the TUI waits for a prompt, so
 * this component says so — a fact only this process has. What it MEANS is the
 * normalizer's (src/status.ts), which reads it as `ready`.
 *
 * Said once per start, and opencode starts a plugin twice: the deck folds the
 * repeat into the state the first one left. A prompt given at spawn may
 * already be running when this lands, and the deck keeps that turn. A 2.x
 * plugin reload starts it again, and over a finished turn the pane then reads
 * Ready: the agent is at its prompt either way, and the turn's notification
 * stands.
 *
 * Its own component, beside the reporter and the courier rather than inside
 * either: the reporter forwards the bus and answers only whose an event is,
 * the courier carries mail, and this states one fact that is neither.
 */
import { READY_EVENT } from "./events.js";
import { makeEnvelope, publish, readBridge } from "./keepdeck-bridge.js";

/** Say the agent is at its prompt. Inert outside a KeepDeck pane; adds no
 * hooks. */
export function announceReady() {
  const bridge = readBridge();
  if (!bridge) return {};
  publish(bridge, makeEnvelope(bridge, "agent.status", { event: { type: READY_EVENT, properties: {} } }));
  return {};
}
