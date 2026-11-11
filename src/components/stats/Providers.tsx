import { Fragment, useMemo } from "react";
import type { AccountUsage } from "../../domain/usage";
import type { UsageLedger } from "../../domain/usage/history/ledger";
import { providerWindowGroups } from "../../domain/usage/providerWindows";
import type { WindowReport } from "../../domain/usage/reportJournal";
import { providersView, type ProviderWindowView } from "../../presentation/stats/providersView";
import { UsageWindowBar } from "../usage/UsageWindowBar";
import { WindowBurn } from "../usage/WindowBurn";

/** Per-provider rate-limit windows joined with ledger spend inside each
 * window's current interval — one card per provider, so the name and the
 * report age appear once instead of repeating on every window. Provider %,
 * reset countdown and the ledger numbers keep separate sources — the
 * section never derives one from the other. Period-independent by design:
 * a subscription window is the provider's clock, not the user's selected
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
  /** The provider-report journal — the forecast's pace history. */
  reportsByKey: ReadonlyMap<string, readonly WindowReport[]>;
  now: number;
}) {
  // Keyed on the SAME clock the captions render with — a memo that read its
  // own Date.now() froze expired/stale while the caption beside them said
  // "reset passed" (round-2 finding). The journal captures synchronously
  // from the usage store, so every journal emit lands in the same flush as
  // the accounts change that caused it.
  const view = useMemo(
    () => providersView(providerWindowGroups(accounts, ledger.events, reportsByKey, now), now, colors),
    [accounts, ledger, reportsByKey, now, colors],
  );
  if (view.kind === "empty") {
    return <p className="stats__empty">{view.text}</p>;
  }
  return (
    <section className="stats__section">
      <h3>{view.title}</h3>
      <div className="stats__providers" role="group" aria-label={view.title}>
        {view.cards.map((card) => (
          <article className="stats__provider" key={card.agent}>
            <header className="stats__provider-head">
              <b>{card.agent}</b>
              <small className={card.updated.className}>{card.updated.text}</small>
            </header>
            {card.note && <p className="stats__provider-idle">{card.note}</p>}
            {card.windows.map((window) => (
              <ProviderWindow key={window.id} view={window} now={now} />
            ))}
          </article>
        ))}
      </div>
    </section>
  );
}

function ProviderWindow({ view, now }: { view: ProviderWindowView; now: number }) {
  return (
    <div className={`stats__window${view.expired ? " stats__window--expired" : ""}`}>
      <div className="stats__window-head">
        <span>{view.label}</span>
        <span className={view.percent.className}>{view.percent.text}</span>
      </div>
      <UsageWindowBar window={view.window} now={now} />
      <WindowBurn geometry={view.burn} stroke={view.stroke} edge={view.edge} now={now} />
      <small>
        {view.caption.map((part, index) => (
          <Fragment key={index}>
            {part.lead}
            <span className={part.className}>{part.text}</span>
          </Fragment>
        ))}
      </small>
      {view.ledger && <small>{view.ledger}</small>}
      {view.sessions.length > 0 && (
        <ul className="stats__window-sessions">
          {view.sessions.map((session) => (
            <li key={session.key}>
              <span>
                {session.name}
                {session.source !== null && <small>{session.source}</small>}
              </span>
              <b>{session.cost}</b>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
