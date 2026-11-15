import { useMemo } from "react";
import type { AccountUsage } from "../../domain/usage";
import type { UsageLedger } from "../../domain/usage/history/ledger";
import type { WindowReport } from "../../domain/usage/reportJournal";
import { accountLimitsView, type ProviderCardView, type ProviderWindowView } from "../../presentation/stats/providersView";
import { UsageWindowBar } from "../usage/UsageWindowBar";
import { LimitsWindowChart } from "./LimitsWindowChart";

/** The Limits tab: one card per provider, and in it each live window — a
 * tile beside its own chart — with the windows there is nothing to chart
 * for as small tiles under them. Period-independent by design: a
 * subscription window is the provider's clock, not the user's selected
 * range. What each card says is settled in
 * presentation/stats/providersView.ts. */
export function Providers({
  accounts,
  ledger,
  colors,
  reportsByKey,
  now,
}: {
  accounts: ReadonlyMap<string, AccountUsage>;
  /** The ledger view — derived values are keyed on it, not on its array. */
  ledger: UsageLedger;
  /** The dialog's series colours (presentation/usagePalette.ts). */
  colors: ReadonlyMap<string, string>;
  /** The provider-report journal — the forecast's pace. */
  reportsByKey: ReadonlyMap<string, readonly WindowReport[]>;
  now: number;
}) {
  // Keyed on the SAME clock the captions render with — a memo that read its
  // own Date.now() froze expired/stale while the caption beside them said
  // "reset passed" (round-2 finding). The journal captures synchronously
  // from the usage store, so every journal emit lands in the same flush as
  // the accounts change that caused it.
  const view = useMemo(
    () => accountLimitsView({ accounts, rows: ledger.events, reportsByKey, now, colors }),
    [accounts, ledger, reportsByKey, now, colors],
  );
  if (view.kind === "empty") {
    return <p className="stats__empty">{view.text}</p>;
  }
  return (
    <section className="stats__section" aria-label={view.title}>
      <div className="stats__providers">
        {view.cards.map((card) => (
          <ProviderCard key={card.agent} card={card} now={now} />
        ))}
      </div>
      {view.note && <p className="stats__coverage">{view.note}</p>}
    </section>
  );
}

function ProviderCard({ card, now }: { card: ProviderCardView; now: number }) {
  return (
    <article className="stats__provider" aria-label={card.agent}>
      <header className="stats__provider-head">
        <b>
          <i style={{ background: card.color }} />
          {card.agent}
        </b>
        <small className={card.updated.className}>{card.updated.text}</small>
      </header>
      {card.charted.map(({ window, chart }) => (
        <div key={window.id} className="stats__provider-row">
          <WindowTile view={window} now={now} lead />
          <LimitsWindowChart view={chart} color={card.color} />
        </div>
      ))}
      {card.others.length > 0 && (
        <div className="stats__provider-others">
          {card.others.map((window) => (
            <WindowTile key={window.id} view={window} now={now} lead={false} />
          ))}
        </div>
      )}
    </article>
  );
}

/** A window's tile — the card's lead window large, the others small. */
function WindowTile({ view, now, lead }: { view: ProviderWindowView; now: number; lead: boolean }) {
  return (
    <div className={`stats__window${lead ? " stats__window--lead" : ""}${view.expired ? " stats__window--expired" : ""}`}>
      <span className="stats__window-head">
        <span className="stats__window-label">{view.label}</span>
        <b className={`stats__window-pct ${view.percent.className ?? ""}`}>{view.percent.text}</b>
      </span>
      <span className="stats__window-bar">
        <UsageWindowBar window={view.window} now={now} />
      </span>
      <small>{view.reset}</small>
      {view.verdict && <small className={view.verdict.className}>{view.verdict.text}</small>}
    </div>
  );
}
