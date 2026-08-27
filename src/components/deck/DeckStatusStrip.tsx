/**
 * The deck's status strip: what is TRUE right now, along the bottom edge.
 *
 * These three things lived in the top bar, interleaved with its actions and
 * its destinations, every one of them at the same weight — so the strip that
 * should have answered "what do I do here" was also answering "how much quota
 * is left" and "is there an update", and a reader had to sort four unrelated
 * kinds of thing by eye.
 *
 * The split is by KIND, not by importance: an action is something you press
 * to change the deck, a destination takes you somewhere, and these are
 * neither — nothing here is a thing to do, they are things that are the case.
 * State that has to stay visible belongs where visible costs least, and the
 * bottom edge is that place: read when looked for, silent otherwise.
 *
 * Two of the three carry a press anyway — quota opens the usage surface, a
 * ready update restarts into it — and that is fine. A fact you can act on is
 * still a fact; what makes it belong here is that it is worth showing when
 * nobody presses it.
 *
 * Nothing here decides whether it is worth showing: `updateAction` arrives
 * null when there is no update, exactly as in the bar, and for the same
 * reason — presence is the composition root's call.
 */
import type { AgentInfo } from "../../domain/agents";
import type { UpdateAction, UpdateActionView } from "../../app/updateAction";
import { Button } from "../../ui/Button";
import { UsageChips } from "../usage/UsageChips";

export interface DeckStatusStripProps {
  /** Agents running in the active workspace. */
  paneCount: number;
  /** The running build, or null until `app_info` answers. */
  version: string | null;

  agents: AgentInfo[];
  /** Agent ids with a pane in the deck — the roster the usage chips stand for. */
  usageLiveAgents: ReadonlySet<string>;
  onOpenStats(): void;

  /** What the update control says and does, or null when there is no update
   *  to speak of. */
  updateAction: UpdateActionView | null;
  onUpdateAction(action: UpdateAction): void;
}

export function DeckStatusStrip({
  paneCount,
  version,
  agents,
  usageLiveAgents,
  onOpenStats,
  updateAction,
  onUpdateAction,
}: DeckStatusStripProps) {
  return (
    <footer className="deck__statusbar">
      <span className="deck__status">
        {paneCount} {paneCount === 1 ? "pane" : "panes"}
        {version ? ` · ${version}` : ""}
      </span>
      <span className="deck__statusbar-spacer" />
      <UsageChips
        agents={agents}
        liveAgents={usageLiveAgents}
        onOpenStats={onOpenStats}
      />
      {updateAction && (
        <Button
          variant="secondary"
          size="sm"
          className="deck__statusbar-update"
          onClick={() => onUpdateAction(updateAction.action)}
          disabled={updateAction.disabled}
          title={updateAction.title}
        >
          {updateAction.label}
        </Button>
      )}
    </footer>
  );
}
