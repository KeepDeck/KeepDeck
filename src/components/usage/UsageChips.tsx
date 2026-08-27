import { useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_FEATURE,
  hasAgentFeature,
  type AgentInfo,
} from "../../domain/agents";
import { DEFAULT_SETTINGS, type UsageDisplay } from "../../domain/settings";
import {
  chipWindows,
  formatAge,
  latestReportedAt,
  usageStale,
  windowLabel,
  type AccountUsage,
} from "../../domain/usage";
import { ledgerSeriesColors } from "../../domain/usage/chartPalette";
import { useUsagePanelAnchor } from "./useUsagePanelAnchor";
import { useSettings } from "../../app/useSettings";
import { useUsageHistorySnapshot } from "../../app/useUsageHistorySnapshot";
import { useUsage } from "../../app/useUsage";
import { useWindowReports } from "../../app/useWindowReports";
import { UsagePanel } from "./UsagePanel";
import { WindowValue } from "./WindowValue";
import { AgentGlyph } from "../../ui/AgentGlyph";
import { Chip } from "../../ui/Chip";
import { useWallClock } from "../../ui/useWallClock";
import { isBehindModalLayer } from "../../ui/inertBackground";

/**
 * The top-bar usage cluster: one chip per ACCOUNT-LIMIT-capable agent with a
 * pane in the deck (immediately — "···" until data) or with a reported
 * account (persisted snapshots keep the bar full after a restart). Pane-only
 * telemetry belongs to pane headers / Usage statistics and never creates a
 * limits chip. Calm by default — color only at the 60/80 thresholds. Clicking
 * a chip opens the anchored panel (the bell's manners) scoped to THAT provider: its
 * windows with client-side reset countdowns. A footer links to the separate
 * global statistics surface; mixing session lifetime into this account-limits
 * popover was the original source of the misleading OpenCode row.
 *
 * Which windows a chip shows (and in what order) is domain policy:
 * [`chipWindows`]/[`panelWindows`].
 */


function UsageChip({
  agent,
  account,
  display,
  now,
  onToggle,
  open,
}: {
  agent: AgentInfo;
  /** Absent = a live agent still waiting for its first report ("···"). */
  account: AccountUsage | undefined;
  display: UsageDisplay;
  now: number;
  onToggle: () => void;
  open: boolean;
}) {
  const stale = account !== undefined && usageStale(account.reportedAt, now);
  const windows = account ? chipWindows(account) : [];
  const title = !account
    ? `${agent.label}: waiting for the first report`
    : stale
      ? `${agent.label}: showing data from ${formatAge(account.reportedAt, now)}`
      : `${agent.label} usage`;
  return (
    <Chip
      className={`usage-chip${stale ? " usage-chip--dim" : ""}`}
      icon={<AgentGlyph icon={agent.icon} />}
      onClick={onToggle}
      title={title}
      aria-expanded={open}
      aria-controls="usage-panel"
      /* Named so the panel can find the chip that opened it and hang from
         THAT one. Addressed by agent id rather than by position in the row:
         the roster changes as agents come and go, and an index would quietly
         start pointing at a neighbour. */
      data-usage-chip={agent.id}
    >
      {windows.length === 0 ? (
        <span className="usage-chip__na">···</span>
      ) : (
        windows.map((window, i) => (
          <span key={i} className="usage-chip__win">
            <span className="usage-chip__label">{windowLabel(window)}</span>
            <WindowValue window={window} display={display} now={now} />
          </span>
        ))
      )}
      {stale && (
        <span className="usage-chip__stale" aria-hidden>
          ⚠
        </span>
      )}
    </Chip>
  );
}

export function UsageChips({
  agents,
  liveAgents,
  onOpenStats,
}: {
  agents: AgentInfo[];
  /** Agent ids with a pane in the deck — account-limit-capable ones earn a
   * chip immediately, so that roster is stable and predictable. */
  liveAgents: ReadonlySet<string>;
  /** Leave account limits and open the global session-usage surface. */
  onOpenStats(): void;
}) {
  const { accounts } = useUsage();
  const journal = useWindowReports();
  // The SAME ledger-roster palette the Stats surfaces key on — memoized
  // here (the owner), so the panel stays prop-driven and an unknown
  // plugin wears one hue everywhere.
  const history = useUsageHistorySnapshot();
  const seriesColors = useMemo(
    () => ledgerSeriesColors(history.events),
    [history.events],
  );
  const settings = useSettings();
  const display = settings?.usageDisplay ?? DEFAULT_SETTINGS.usageDisplay;
  // The open PANEL is per provider — a chip opens ITS agent's details.
  const [openProvider, setOpenProvider] = useState<string | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);

  // Catalog order keeps the cluster stable. A chip exists for every
  // ACCOUNT-LIMIT-capable agent WITH A PANE (immediately — "···" until data)
  // and for every REPORTED account (persisted snapshots keep the bar populated
  // after a restart, honestly aged). The "unavailable" arm has no producer.
  const providers = agents.filter(
    (agent) =>
      (hasAgentFeature(agent.features, AGENT_FEATURE.accountUsage) &&
        agent.usageAvailable === true &&
        liveAgents.has(agent.id)) ||
      accounts.get(agent.id)?.kind === "reported",
  );

  // The open provider can lose its chip (pane closed, no reported account)
  // — close the panel rather than leaving an orphaned empty shell.
  const providersKey = providers.map((a) => a.id).join("\n");
  useEffect(() => {
    if (openProvider !== null && !providersKey.split("\n").includes(openProvider)) {
      setOpenProvider(null);
    }
  }, [openProvider, providersKey]);

  // Countdowns and staleness drift with wall time — the shared slow-tick
  // clock advances them. The newest report floors the clock: a report
  // landing on a long-idle chip must never read as stale (or negative-aged)
  // against a now that last ticked before it arrived.
  const latestReport = useMemo(() => latestReportedAt(accounts.values()), [accounts]);
  const now = useWallClock(latestReport);

  // Light-dismiss: any pointer press outside (or Escape) closes the panel.
  const open = openProvider !== null;

  // Where the panel hangs — measuring is its own job, with its own listener to
  // keep and drop, so it lives in its own hook.
  const panelLeft = useUsagePanelAnchor(rootRef, openProvider, providersKey);

  useEffect(() => {
    if (!open) return;
    // Yields to a dialog stacked over the panel, for the reason spelled out
    // in [`NotificationBell`]: these are capture-phase, so one Escape would
    // otherwise dismiss this panel and the dialog above it.
    const onPress = (e: PointerEvent) => {
      if (isBehindModalLayer(rootRef.current)) return;
      if (!rootRef.current?.contains(e.target as Node)) setOpenProvider(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || isBehindModalLayer(rootRef.current)) return;
      setOpenProvider(null);
    };
    document.addEventListener("pointerdown", onPress, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPress, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (providers.length === 0) return null;
  return (
    <span className="usage" ref={rootRef}>
      {providers.map((agent) => (
        <UsageChip
          key={agent.id}
          agent={agent}
          account={accounts.get(agent.id)}
          display={display}
          now={now}
          open={openProvider === agent.id}
          onToggle={() =>
            setOpenProvider((current) => (current === agent.id ? null : agent.id))
          }
        />
      ))}
      {open && openProvider !== null && (
        <UsagePanel
          providers={providers}
          openProvider={openProvider}
          accounts={accounts}
          display={display}
          now={now}
          reportsByKey={journal.byKey}
          seriesColors={seriesColors}
          onOpenStats={onOpenStats}
          onClose={() => setOpenProvider(null)}
          // Hidden until measured: one frame at the stylesheet's default
          // position, before the chip's offset is known, would read as the
          // panel jumping into place.
          style={
            panelLeft === null
              ? { visibility: "hidden" }
              : { left: panelLeft, right: "auto" }
          }
        />
      )}
    </span>
  );
}
