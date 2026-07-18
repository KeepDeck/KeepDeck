import { useEffect, useReducer, useRef, useState } from "react";
import type { AgentInfo } from "../../domain/agents";
import { DEFAULT_SETTINGS, type UsageDisplay } from "../../domain/settings";
import {
  formatAge,
  formatCountdown,
  formatPct,
  limitLevel,
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
 * The top-bar usage cluster: one chip per provider with account state,
 * calm by default — color only at the 60/80 thresholds. Clicking any chip
 * opens one anchored panel (the bell's manners) detailing every provider's
 * windows with client-side reset countdowns; idle panes stop reporting but
 * the clock keeps ticking from the absolute `resetsAt`.
 *
 * A provider without state contributes NO chip — the cluster is invisible
 * until the first report lands.
 */

/** Account-wide windows, shortest first — the chip shows up to two;
 * model-scoped windows appear only in the panel. */
function accountWindows(account: AccountUsage): UsageWindow[] {
  if (account.kind !== "reported") return [];
  return [...account.windows]
    .filter((w) => w.scope === undefined)
    .sort(
      (a, b) => (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity),
    );
}

/** Every window for the panel, scoped ones after account-wide. */
function panelWindows(account: AccountUsage): UsageWindow[] {
  if (account.kind !== "reported") return [];
  return [...account.windows].sort(
    (a, b) =>
      Number(a.scope !== undefined) - Number(b.scope !== undefined) ||
      (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity),
  );
}

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
  const cls =
    expired || level === "ok" ? "" : ` usage-level--${level}`;
  return (
    <span
      className={`usage-window__value${cls}${expired ? " usage-window--expired" : ""}`}
    >
      {formatPct(window.usedPct, display)}
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
  const windows = accountWindows(account).slice(0, 2);
  const title =
    account.kind === "unavailable"
      ? `${agent.label}: API-key billing — no plan windows`
      : stale
        ? `${agent.label}: showing data from ${formatAge(account.reportedAt, now)}`
        : `${agent.label} usage`;
  return (
    <button
      type="button"
      className={`usage-chip${stale || account.kind === "unavailable" ? " usage-chip--dim" : ""}`}
      onClick={onToggle}
      title={title}
      aria-expanded={open}
    >
      <span className="usage-chip__glyph" aria-hidden>
        <AgentGlyph icon={agent.icon} />
      </span>
      {account.kind === "unavailable" ? (
        <span className="usage-chip__na">--</span>
      ) : windows.length === 0 ? (
        <span className="usage-chip__na">···</span>
      ) : (
        windows.map((window, i) => (
          <span key={i} className="usage-chip__win">
            <span className="usage-chip__label">{windowLabel(window)}</span>
            {i === 0 && (
              <span className="usage-bar" aria-hidden>
                <i
                  className={
                    windowExpired(window, now) || limitLevel(window.usedPct) === "ok"
                      ? ""
                      : `usage-level--${limitLevel(window.usedPct)}`
                  }
                  style={{ width: `${Math.round(window.usedPct)}%` }}
                />
              </span>
            )}
            <WindowValue window={window} display={display} now={now} />
          </span>
        ))
      )}
      {stale && account.kind === "reported" && (
        <span className="usage-chip__stale" aria-hidden>
          ⚠
        </span>
      )}
    </button>
  );
}

export function UsageChips({ agents }: { agents: AgentInfo[] }) {
  const { accounts } = useUsage();
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

  // Catalog order keeps the cluster stable; providers without state
  // contribute nothing.
  const providers = agents.filter((agent) => accounts.has(agent.id));
  if (providers.length === 0) return null;
  const now = Date.now();

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
        <div className="usage-panel" role="group" aria-label="Usage">
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
                {account.kind === "unavailable" ? (
                  <div className="usage-panel__na">
                    API-key billing — no plan windows
                  </div>
                ) : (
                  panelWindows(account).map((window, i) => {
                    const expired = windowExpired(window, now);
                    const countdown = formatCountdown(window.resetsAt, now);
                    return (
                      <div key={i} className="usage-window">
                        <span className="usage-window__label">
                          {windowLabel(window)}
                        </span>
                        <span className="usage-bar usage-bar--row" aria-hidden>
                          <i
                            className={
                              expired || limitLevel(window.usedPct) === "ok"
                                ? ""
                                : `usage-level--${limitLevel(window.usedPct)}`
                            }
                            style={{ width: `${Math.round(window.usedPct)}%` }}
                          />
                        </span>
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
                  })
                )}
              </div>
            );
          })}
        </div>
      )}
    </span>
  );
}
