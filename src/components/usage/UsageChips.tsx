import { useEffect, useReducer, useRef, useState } from "react";
import type { AgentInfo } from "../../domain/agents";
import { DEFAULT_SETTINGS, type UsageDisplay } from "../../domain/settings";
import {
  chipWindows,
  formatAge,
  formatPct,
  formatTokens,
  limitLevel,
  panelWindows,
  usageStale,
  windowExpired,
  windowLabel,
  windowResetCaption,
  type AccountUsage,
  type UsageWindow,
} from "../../domain/usage";
import { updateSettings } from "../../app/settingsManager";
import { useSettings } from "../../app/useSettings";
import { useUsage } from "../../app/useUsage";
import { AgentGlyph } from "../../ui/AgentGlyph";

/**
 * The top-bar usage cluster: one chip per usage-declaring agent with a
 * pane in the deck (immediately — "···" until data) or with a reported
 * account (persisted snapshots keep the bar full after a restart). Calm
 * by default — color only at the 60/80 thresholds. Clicking a chip opens
 * the anchored panel (the bell's manners) scoped to THAT provider: its
 * windows with client-side reset countdowns and its live session rows
 * (model, context, cost). Idle panes stop reporting but the countdown
 * clocks keep ticking from the absolute `resetsAt`.
 *
 * Which windows a chip shows (and in what order) is domain policy:
 * [`chipWindows`]/[`panelWindows`].
 */

function WindowValue({
  window,
  display,
  now,
}: {
  window: UsageWindow;
  display: UsageDisplay;
  now: number;
}) {
  const expired = windowExpired(window, now);
  const level = limitLevel(window.usedPct);
  const cls = expired || level === "ok" ? "" : ` usage-level--${level}`;
  return (
    <span
      className={`usage-window__value${cls}${expired ? " usage-window--expired" : ""}`}
    >
      {formatPct(window.usedPct, display)}
    </span>
  );
}

/** The panel's fill bar. Chips deliberately carry NONE: a bar next to one
 * number but not its neighbor read as noise (field report) — the chip is
 * numbers only, the panel visualizes. */
function Bar({ window, now }: { window: UsageWindow; now: number }) {
  const level = limitLevel(window.usedPct);
  return (
    <span className="usage-bar" aria-hidden>
      <i
        className={
          windowExpired(window, now) || level === "ok" ? "" : `usage-level--${level}`
        }
        style={{ width: `${Math.round(window.usedPct)}%` }}
      />
    </span>
  );
}

function Chip({
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
    <button
      type="button"
      className={`usage-chip${stale ? " usage-chip--dim" : ""}`}
      onClick={onToggle}
      title={title}
      aria-expanded={open}
      aria-controls="usage-panel"
    >
      <span className="usage-chip__glyph" aria-hidden>
        <AgentGlyph icon={agent.icon} />
      </span>
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
    </button>
  );
}

export function UsageChips({
  agents,
  liveAgents,
  paneNames,
}: {
  agents: AgentInfo[];
  /** Agent ids with a pane in the deck — every one earns a chip, data or
   * not, so the roster is stable and predictable. */
  liveAgents: ReadonlySet<string>;
  /** Pane id → display title, for the panel's session rows. */
  paneNames: ReadonlyMap<string, string>;
}) {
  const { accounts, panes } = useUsage();
  const settings = useSettings();
  const display = settings?.usageDisplay ?? DEFAULT_SETTINGS.usageDisplay;
  // The open PANEL is per provider — a chip opens ITS agent's details.
  const [openProvider, setOpenProvider] = useState<string | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);

  // Catalog order keeps the cluster stable. A chip exists for every agent
  // WITH A PANE (immediately — "···" until data) and for every REPORTED
  // account (persisted snapshots keep the bar populated after a restart,
  // honestly aged). The "unavailable" contract arm has no producer today.
  const providers = agents.filter(
    (agent) =>
      (agent.reportsUsage === true && liveAgents.has(agent.id)) ||
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

  // Countdowns and staleness drift with wall time — a slow tick re-renders
  // them; nothing else here depends on it.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (accounts.size === 0) return;
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [accounts.size]);

  // Light-dismiss: any pointer press outside (or Escape) closes the panel.
  const open = openProvider !== null;
  useEffect(() => {
    if (!open) return;
    const onPress = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpenProvider(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenProvider(null);
    };
    document.addEventListener("pointerdown", onPress, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPress, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (providers.length === 0) return null;
  const now = Date.now();
  const sessions = [...panes.entries()]
    .filter(([, usage]) => usage.agent === openProvider)
    .sort(([a], [b]) => a.localeCompare(b));

  return (
    <span className="usage" ref={rootRef}>
      {providers.map((agent) => (
        <Chip
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
      {open && (
        <div className="usage-panel" id="usage-panel" role="group" aria-label="Usage">
          <div className="usage-panel__head">
            <span className="usage-panel__title">Usage</span>
            <button
              type="button"
              className="usage-panel__toggle"
              onClick={() =>
                updateSettings({ usageDisplay: display === "used" ? "left" : "used" })
              }
              title="Switch between % used and % left"
            >
              % {display}
            </button>
          </div>
          {providers
            .filter((agent) => agent.id === openProvider)
            .map((agent) => {
            const account = accounts.get(agent.id);
            if (!account) {
              return (
                <div key={agent.id} className="usage-panel__section">
                  <div className="usage-panel__provider">
                    <b>{agent.label}</b>
                    <span className="usage-panel__ago">
                      waiting for the first report
                    </span>
                  </div>
                </div>
              );
            }
            return (
              <div key={agent.id} className="usage-panel__section">
                <div className="usage-panel__provider">
                  <b>{agent.label}</b>
                  <span className="usage-panel__ago">
                    Updated {formatAge(account.reportedAt, now)}
                  </span>
                </div>
                {panelWindows(account).map((window, i) => {
                  return (
                    <div key={i} className="usage-window">
                      <span className="usage-window__label">
                        {windowLabel(window, "long")}
                      </span>
                      <Bar window={window} now={now} />
                      <span className="usage-window__detail">
                        <WindowValue window={window} display={display} now={now} />
                        <small>{windowResetCaption(window, now)}</small>
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {sessions.length > 0 && (
            <div className="usage-panel__section">
              <div className="usage-panel__provider">
                <b>Sessions</b>
                <span className="usage-panel__ago">live</span>
              </div>
              {sessions.map(([paneId, usage]) => (
                <div key={paneId} className="usage-session">
                  <span className="usage-session__name">
                    {paneNames.get(paneId) || usage.model || usage.agent}
                  </span>
                  {usage.model && (
                    <span className="usage-session__model">{usage.model}</span>
                  )}
                  <span className="usage-session__stats">
                    {usage.totalTokens &&
                      (usage.totalTokens.input !== undefined ||
                        usage.totalTokens.output !== undefined) && (
                        <span
                          className="usage-session__tokens"
                          title="Session tokens — input ↑ / output ↓"
                        >
                          ↑{formatTokens(usage.totalTokens.input ?? 0)} ↓
                          {formatTokens(usage.totalTokens.output ?? 0)}
                        </span>
                      )}
                    {usage.costUsd !== undefined && (
                      <span>${usage.costUsd.toFixed(2)}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
