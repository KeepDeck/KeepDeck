import { useMemo, useState } from "react";
import type { UsageLedger } from "../../domain/usage/history/ledger";
import type { JournalRecords } from "../../domain/journal/sessionLog";
import type { StatsDimension } from "../../domain/usage/stats/dimensions";
import { teamHistory } from "../../domain/usage/stats/teams";
import type { StatsPeriod } from "../../domain/usage/stats/period";
import {
  breakdownView,
  type BreakdownOrder,
  type BreakdownRowView,
  type ChoicesView,
} from "../../presentation/stats/breakdownView";

/** The Breakdown tab body: one table over any dimension. What it shows is
 * settled in presentation/stats/breakdownView.ts; the group the reader
 * opened is this table's own UI state, the dimension and order are the
 * app-level view's. */
export function Breakdown({
  ledger,
  period,
  now,
  colors,
  perModelSince,
  journal,
  dimension,
  order,
  onSelectDimension,
  onSelectOrder,
}: {
  /** The ledger view — derived values are keyed on it, not on its array. */
  ledger: UsageLedger;
  period: StatsPeriod;
  now: number;
  colors: ReadonlyMap<string, string>;
  perModelSince: number | null;
  /** The session journal — where the teams of past sessions are read. */
  journal: JournalRecords;
  dimension: StatsDimension;
  order: BreakdownOrder;
  onSelectDimension(dimension: StatsDimension): void;
  onSelectOrder(order: BreakdownOrder): void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const teams = useMemo(() => teamHistory(journal), [journal]);
  const view = useMemo(
    () => breakdownView(ledger.events, { period, now, dimension, order, open, colors, perModelSince, teams }),
    [ledger, period, now, dimension, order, open, colors, perModelSince, teams],
  );
  return (
    <>
      <div className="stats__bd-head">
        <Choices view={view.dimensions} onPick={onSelectDimension} />
        <Choices view={view.orders} onPick={onSelectOrder} />
      </div>
      <div className="stats__bd" role="table">
        <div className="stats__bd-row stats__bd-row--head" role="row">
          <span role="columnheader">{view.columns.name}</span>
          <span role="columnheader">{view.columns.share}</span>
          <span role="columnheader">{view.columns.cost}</span>
          <span role="columnheader">{view.columns.change}</span>
          <span role="columnheader">{view.columns.output}</span>
          <span role="columnheader">{view.columns.last}</span>
        </div>
        {view.rows.map((row) => (
          <Group key={row.key} row={row} onToggle={() => setOpen(row.toggle)} />
        ))}
      </div>
      {view.notes.map((note) => (
        <p key={note} className="stats__coverage">{note}</p>
      ))}
    </>
  );
}

function Choices<T extends string>({ view, onPick }: { view: ChoicesView<T>; onPick(id: T): void }) {
  return (
    <div className="stats__choices" role="group" aria-label={view.label}>
      {view.items.map((item) => (
        <button
          key={item.id}
          type="button"
          className={item.active ? "stats__choices--active" : ""}
          aria-pressed={item.active}
          onClick={() => onPick(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function Group({ row, onToggle }: { row: BreakdownRowView; onToggle(): void }) {
  return (
    <>
      <Row row={row} onToggle={row.opens ? onToggle : undefined} />
      {row.sessions.map((session) => (
        <Row key={session.key} row={session} child />
      ))}
    </>
  );
}

function Row({ row, child = false, onToggle }: { row: BreakdownRowView; child?: boolean; onToggle?: () => void }) {
  const name = (
    <>
      <b>{row.name}</b>
      {row.source !== null && <small>{row.source}</small>}
    </>
  );
  return (
    <div
      className={`stats__bd-row${child ? " stats__bd-row--child" : ""}${row.folded ? " stats__bd-row--folded" : ""}`}
      role="row"
    >
      <span className="stats__bd-name" role="cell">
        {onToggle ? (
          <button type="button" className="stats__bd-toggle" aria-expanded={row.open} onClick={onToggle}>
            {name}
          </button>
        ) : (
          name
        )}
      </span>
      <span className="stats__bd-share" role="cell">
        <span className="stats__bd-track">
          <span className="stats__bd-bar" style={{ width: `${row.width * 100}%` }}>
            {row.split.map((part) => (
              <i key={part.agent} style={{ flexGrow: part.weight, background: part.color }} />
            ))}
          </span>
        </span>
        <em>{row.shareText}</em>
      </span>
      <span className="stats__bd-num" role="cell"><b>{row.cost}</b></span>
      <span className="stats__bd-num" role="cell">
        {row.change && <span className={`stats__change stats__change--${row.change.tone}`}>{row.change.text}</span>}
        {row.noChange}
      </span>
      <span className="stats__bd-num" role="cell">{row.output}</span>
      <span className="stats__bd-num stats__bd-last" role="cell">{row.last}</span>
    </div>
  );
}
