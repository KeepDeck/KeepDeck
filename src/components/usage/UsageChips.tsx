import { useEffect, useReducer, useRef, useState } from "react";
import type { AgentInfo } from "../../domain/agents";
import { DEFAULT_SETTINGS, type UsageDisplay } from "../../domain/settings";
import {
  chipWindows,
  contextLevel,
  contextPct,
  formatAge,
  formatCountdown,
  formatPct,
  limitLevel,
  panelWindows,
  usageStale,
  windowExpired,
  windowLabel,
  type AccountUsage,
  type UsageWindow,
} from "../../domain/usage";
import { updateSettings } from "../../app/settingsManager";
import { useSettings } from "../../app/useSettings";
import { useUsage } from "../../app/useUsage";
import { AgentGlyph } from "../../ui/AgentGlyph";

/**
 * The top-bar usage cluster: one chip per provider with REPORTED account
 * state, calm by default — color only at the 60/80 thresholds. Clicking
 * any chip opens the one anchored panel (the bell's manners) detailing
 * every provider's windows with client-side reset countdowns, plus the
 * live per-pane session rows (model, context, cost). Idle panes stop
 * reporting but the countdown clocks keep ticking from the absolute
 * `resetsAt`.
 *
 * A provider without reported state contributes NO chip — the cluster is
 * invisible until the first report lands. Which windows a chip shows (and
 * in what order) is domain policy: [`chipWindows`]/[`panelWindows`].
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

function Bar({ window, now, row }: { window: UsageWindow; now: number; row?: boolean }) {
  const level = limitLevel(window.usedPct);
  return (
    <span className={`usage-bar${row ? " usage-bar--row" : ""}`} aria-hidden>
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
  account: AccountUsage;
  display: UsageDisplay;
  now: number;
  onToggle: () => void;
  open: boolean;
}) {
  const stale = usageStale(account.reportedAt, now);
  const windows = chipWindows(account);
  const title = stale
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
            {i === 0 && <Bar window={window} now={now} />}
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
  paneNames,
}: {
  agents: AgentInfo[];
  /** Pane id → display title, for the panel's session rows. */
  paneNames: ReadonlyMap<string, string>;
}) {
  const { accounts, panes } = useUsage();
  const settings = useSettings();
  const display = settings?.usageDisplay ?? DEFAULT_SETTINGS.usageDisplay;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  // Countdowns and staleness drift with wall time — a slow tick re-renders
  // them; nothing else here depends on it.
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (accounts.size === 0) return;
    const timer = setInterval(tick, 30_000);
    return () => clearInterval(timer);
  }, [accounts.size]);

  // Light-dismiss: any pointer press outside (or Escape) closes the panel.
  useEffect(() => {
    if (!open) return;
    const onPress = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPress, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPress, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // Catalog order keeps the cluster stable; only REPORTED accounts earn a
  // chip (the contract's "unavailable" arm has no producer today).
  const providers = agents.filter(
    (agent) => accounts.get(agent.id)?.kind === "reported",
  );
  if (providers.length === 0) return null;
  const now = Date.now();
  const sessions = [...panes.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <span className="usage" ref={rootRef}>
      {providers.map((agent) => (
        <Chip
          key={agent.id}
          agent={agent}
          account={accounts.get(agent.id)!}
          display={display}
          now={now}
          open={open}
          onToggle={() => setOpen((o) => !o)}
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
          {providers.map((agent) => {
            const account = accounts.get(agent.id)!;
            return (
              <div key={agent.id} className="usage-panel__section">
                <div className="usage-panel__provider">
                  <b>{agent.label}</b>
                  <span className="usage-panel__ago">
                    Updated {formatAge(account.reportedAt, now)}
                  </span>
                </div>
                {panelWindows(account).map((window, i) => {
                  const expired = windowExpired(window, now);
                  const countdown = formatCountdown(window.resetsAt, now);
                  return (
                    <div key={i} className="usage-window">
                      <span className="usage-window__label">
                        {windowLabel(window)}
                      </span>
                      <Bar window={window} now={now} row />
                      <span className="usage-window__detail">
                        <WindowValue window={window} display={display} now={now} />
                        <small>
                          {expired
                            ? "reset passed · awaiting report"
                            : countdown
                              ? `resets in ${countdown}`
                              : "reset unknown"}
                        </small>
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
              {sessions.map(([paneId, usage]) => {
                const ctx = contextPct(usage.context);
                return (
                  <div key={paneId} className="usage-session">
                    <span className="usage-session__name">
                      {paneNames.get(paneId) || usage.model || usage.agent}
                    </span>
                    {usage.model && (
                      <span className="usage-session__model">{usage.model}</span>
                    )}
                    <span className="usage-session__stats">
                      {ctx !== undefined && (
                        <span
                          className={
                            contextLevel(ctx) === "ok"
                              ? ""
                              : `usage-level--${contextLevel(ctx)}`
                          }
                        >
                          ctx {Math.ceil(ctx)}%
                        </span>
                      )}
                      {usage.costUsd !== undefined && (
                        <span>${usage.costUsd.toFixed(2)}</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </span>
  );
}
