import { findWorkspaceOfPane, remoteEndpointOf } from "../domain/deck";
import { onSessionUnbound } from "../ipc/sessions";
import { createDeckActions } from "./deckActions";
import type { DeckStore } from "./deckStore";
import type { PaneAttribution } from "./paneAttribution";
import type { PaneLifecycle } from "./paneLifecycle";
import {
  createVerifiedPaneReports,
  type PaneReportEvent,
  type VerifiedPaneReports,
} from "./verifiedPaneReports";

/**
 * The bridge lane for session unbindings: the pane's agent left its
 * conversation for none at all — opencode's `/new` waits on the home screen,
 * and its next session exists only once the first prompt is sent.
 *
 * The pane then has no session: KeepDeck forgets the one it had, so a
 * restore before the next binding starts the agent fresh rather than
 * reopening the conversation the user left — they continue where they left
 * off, which was the empty screen. Its telemetry ends with it.
 *
 * Verified like every pane report — the pane's secret, its agent, its pinned
 * process, a live process — since forgetting a session is as much a claim
 * about the pane as binding one. A remote pane binds nothing locally, so it
 * has nothing to forget.
 */
export function listenPaneUnbinds(
  deck: DeckStore,
  attribution: PaneAttribution,
  lifecycle: PaneLifecycle,
  subscribe: (handler: (report: PaneReportEvent) => void) => Promise<() => void> =
    onSessionUnbound,
): VerifiedPaneReports {
  const actions = createDeckActions(deck);
  return createVerifiedPaneReports(deck, attribution, {
    label: "session unbinding",
    subscribe,
    requireLiveProcess: true,
    apply(paneId) {
      const ws = findWorkspaceOfPane(deck.getSnapshot().workspaces, paneId);
      const pane = ws?.panes.find((candidate) => candidate.id === paneId);
      if (!ws || !pane?.session || remoteEndpointOf(pane) !== null) return;
      actions.resetPaneSession(ws.id, paneId);
      lifecycle.endSession(paneId);
    },
  });
}
