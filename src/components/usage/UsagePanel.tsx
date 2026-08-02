import type { AgentInfo } from "../../domain/agents";
import type { UsageDisplay } from "../../domain/settings";
import {
  formatAge,
  panelWindows,
  windowLabel,
  type AccountUsage,
} from "../../domain/usage";
import { agentSeriesColors } from "../../domain/usage/chartPalette";
import {
  accountWindowKeys,
  NO_REPORTS,
  type WindowReport,
} from "../../domain/usage/reportJournal";
import {
  panelWindowCaption,
  windowForecast,
} from "../../domain/usage/windowForecast";
import { updateSettings } from "../../app/settingsManager";
import { UsageWindowBar } from "./UsageWindowBar";
import { WindowBurn } from "./WindowBurn";
import { WindowValue } from "./UsageChips";

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
  onOpenStats,
  onClose,
}: {
  providers: AgentInfo[];
  openProvider: string;
  accounts: ReadonlyMap<string, AccountUsage>;
  display: UsageDisplay;
  now: number;
  reportsByKey: ReadonlyMap<string, readonly WindowReport[]>;
  onOpenStats(): void;
  onClose(): void;
}) {
  // Colors keyed on the chip roster — the best roster this surface has.
  // (The Overview chart keys on the full LEDGER roster; a plugin provider
  // may differ there until it earns a fixed slot.)
  const colors = agentSeriesColors(providers.map((provider) => provider.id));
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
          // Keys minted over the account's OWN window order — the same rule
          // the journal writer applies, so every row reads its own history.
          const keys = accountWindowKeys(agent.id, account.windows);
          return (
            <div key={agent.id} className="usage-panel__section">
              <div className="usage-panel__provider">
                <b>{agent.label}</b>
                <span className="usage-panel__ago">
                  Updated {formatAge(account.reportedAt, now)}
                </span>
              </div>
              {panelWindows(account).map((window, i) => {
                const key = keys.get(window)?.key;
                const reports =
                  (key !== undefined ? reportsByKey.get(key) : undefined) ??
                  NO_REPORTS;
                const forecast = windowForecast(reports, window, now);
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
                      stroke={colors.get(agent.id)}
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
