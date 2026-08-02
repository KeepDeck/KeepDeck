import type { AgentInfo } from "../../domain/agents";
import type { UsageDisplay } from "../../domain/settings";
import {
  formatAge,
  panelWindows,
  windowLabel,
  type AccountUsage,
} from "../../domain/usage";
import { seriesColorFor } from "../../domain/usage/chartPalette";
import { type WindowReport } from "../../domain/usage/reportJournal";
import {
  accountWindowForecasts,
  panelWindowCaption,
} from "../../domain/usage/windowForecast";
import { updateSettings } from "../../app/settingsManager";
import { UsageWindowBar } from "./UsageWindowBar";
import { WindowBurn } from "./WindowBurn";
import { WindowValue } from "./WindowValue";

/**
 * The chips' anchored panel: one provider's windows with bars, the
 * next-relevant-event caption (reset, or the run-out that beats it) and
 * the compact burn sparkline. Extracted from UsageChips so the panel body
 * is testable on its own and the chips file keeps one job.
 */
export function UsagePanel({
  providers,
  openProvider,
  accounts,
  display,
  now,
  reportsByKey,
  seriesColors,
  onOpenStats,
  onClose,
}: {
  providers: AgentInfo[];
  openProvider: string;
  accounts: ReadonlyMap<string, AccountUsage>;
  display: UsageDisplay;
  now: number;
  reportsByKey: ReadonlyMap<string, readonly WindowReport[]>;
  /** The ledger-roster palette, owned by UsageChips. */
  seriesColors: ReadonlyMap<string, string>;
  onOpenStats(): void;
  onClose(): void;
}) {
  return (
    <div
      className="usage-panel"
      id="usage-panel"
      role="group"
      aria-label="Account limits"
    >
      <div className="usage-panel__head">
        <span className="usage-panel__title">Account limits</span>
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
          if (!account || account.kind !== "reported") {
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
          // THE domain join of windows → series → forecasts; keyed by
          // window object identity, so the panelWindows re-sort below still
          // finds each row.
          const rows = accountWindowForecasts(
            agent.id,
            account,
            reportsByKey,
            now,
          );
          return (
            <div key={agent.id} className="usage-panel__section">
              <div className="usage-panel__provider">
                <b>{agent.label}</b>
                <span className="usage-panel__ago">
                  Updated {formatAge(account.reportedAt, now)}
                </span>
              </div>
              {panelWindows(account).map((window, i) => {
                // Same-object lookup into the join above cannot miss today
                // (panelWindows re-sorts a copy of the ARRAY, not its
                // elements) — but if that invariant ever breaks, drop the
                // ROW, not the whole popover.
                const row = rows.get(window);
                if (!row) return null;
                const { reports, forecast } = row;
                // THE next relevant event, one per row: the reset while
                // the pace survives it, the run-out once it does not.
                const caption = panelWindowCaption(window, forecast, now);
                return (
                  <div key={i} className="usage-window">
                    <span className="usage-window__label">
                      {windowLabel(window, "long")}
                    </span>
                    <UsageWindowBar window={window} now={now} />
                    <span className="usage-window__detail">
                      <WindowValue window={window} display={display} now={now} />
                      {caption.text && (
                        <small
                          className={
                            caption.level
                              ? `usage-level--${caption.level}`
                              : undefined
                          }
                        >
                          {caption.text}
                        </small>
                      )}
                    </span>
                    <WindowBurn
                      stroke={seriesColorFor(seriesColors, agent.id)}
                      window={window}
                      reports={reports}
                      forecast={forecast}
                      now={now}
                      size="compact"
                    />
                  </div>
                );
              })}
            </div>
          );
        })}
      <button
        type="button"
        className="usage-panel__stats"
        onClick={() => {
          onClose();
          onOpenStats();
        }}
      >
        Open statistics
        <span aria-hidden>→</span>
      </button>
    </div>
  );
}
