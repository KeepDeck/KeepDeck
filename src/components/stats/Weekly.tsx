import { useMemo } from "react";
import type { JournalRecords } from "../../domain/journal/sessionLog";
import { usageAchievementLadders } from "../../domain/usage/achievements/ladders";
import type { UsageLedger } from "../../domain/usage/history/ledger";
import type { WindowReport } from "../../domain/usage/reportJournal";
import { teamHistory } from "../../domain/usage/stats/teams";
import { weeklyView, type BarsView, type WeeklyView } from "../../presentation/stats/weeklyView";

/** The Weekly tab body: one calendar week as a report. What it says is
 * settled in presentation/stats/weeklyView.ts; which week is shown is this
 * tab's own UI state, opening on this week. */
export function Weekly({
  ledger,
  now,
  week,
  onSelectWeek,
  journal,
  reportsByKey,
  onOpenGallery,
}: {
  ledger: UsageLedger;
  now: number;
  /** The reported week, held by the app-level view so a digest can land
   * on it; null follows the current week. */
  week: number | null;
  onSelectWeek(week: number | null): void;
  journal: JournalRecords;
  reportsByKey: ReadonlyMap<string, readonly WindowReport[]>;
  onOpenGallery(): void;
}) {
  const teams = useMemo(() => teamHistory(journal), [journal]);
  const ladders = useMemo(() => usageAchievementLadders(ledger.events), [ledger]);
  const view = useMemo(
    () => weeklyView(ledger.events, { now, week, teams, reports: reportsByKey, ladders }),
    [ledger, now, week, teams, reportsByKey, ladders],
  );
  return (
    <div className="stats__weekly">
      <div className="stats__weeknav">
        <Arrow label={view.nav.olderLabel} to={view.nav.older} glyph="‹" onGo={onSelectWeek} />
        <b>{view.nav.label}</b>
        <Arrow label={view.nav.newerLabel} to={view.nav.newer} glyph="›" onGo={onSelectWeek} />
      </div>
      <div className="stats__week-top">
        <section className="stats__week-report" aria-label={view.spent.label}>
          <span className="stats__figure-label">{view.spent.label}</span>
          <b className="stats__week-value">{view.spent.value}</b>
          <span className="stats__figure-caption">
            {view.spent.change && (
              <span className={`stats__change stats__change--${view.spent.change.tone}`}>{view.spent.change.text}</span>
            )}
            {view.spent.caption}
          </span>
          <ul className="stats__week-lines">
            {view.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
        <Calendar calendar={view.calendar} />
      </div>
      <div className="stats__glance">
        {view.rhythm.map((group) => (
          <Bars key={group.title} view={group} />
        ))}
        <section className="stats__top" aria-label={view.peaks.title}>
          <h3>{view.peaks.title}</h3>
          {view.peaks.empty !== null && <p className="stats__top-empty">{view.peaks.empty}</p>}
          {view.peaks.rows.map((row) => (
            <div key={row.key} className="stats__top-row">
              <span className="stats__top-name">{row.label}</span>
              <b>{row.pct}</b>
            </div>
          ))}
        </section>
      </div>
      <div className="stats__glance">
        {view.lists.map((list) => (
          <section key={list.title} className="stats__top" aria-label={list.title}>
            <h3>{list.title}</h3>
            {list.rows.map((row) => (
              <div key={row.key} className={`stats__top-row${row.folded ? " stats__top-row--folded" : ""}`}>
                <span className="stats__top-name">
                  {row.name}
                  {row.source !== null && <small>{row.source}</small>}
                </span>
                <b>
                  <small>{row.share}</small> {row.cost}
                </b>
              </div>
            ))}
          </section>
        ))}
        {view.badges && (
          <section className="stats__top" aria-label={view.badges.title}>
            <h3>
              {view.badges.title}
              <button type="button" className="stats__link" onClick={onOpenGallery}>
                {view.badges.link}
              </button>
            </h3>
            {view.badges.rows.map((row) => (
              <div key={row.id} className="stats__top-row">
                <span className="stats__top-name">{row.title}</span>
                <b>{row.pct}</b>
              </div>
            ))}
          </section>
        )}
      </div>
      {view.notes.map((note) => (
        <p key={note} className="stats__coverage">{note}</p>
      ))}
    </div>
  );
}

function Calendar({ calendar }: { calendar: WeeklyView["calendar"] }) {
  return (
    <section className="stats__heat" aria-label={calendar.title}>
      <h3>
        {calendar.title} <small>{calendar.caption}</small>
      </h3>
      <div className="stats__heat-grid">
        {calendar.weeks.map((week) => (
          <div key={week.key} className="stats__heat-week">
            {week.days.map((day) => (
              <i
                key={day.key}
                className={day.selected ? "stats__heat--selected" : undefined}
                data-level={day.level}
                title={day.title}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

function Arrow({
  label,
  to,
  glyph,
  onGo,
}: {
  label: string;
  to: { week: number | null } | null;
  glyph: string;
  onGo(week: number | null): void;
}) {
  return (
    <button type="button" aria-label={label} disabled={to === null} onClick={() => to !== null && onGo(to.week)}>
      {glyph}
    </button>
  );
}

function Bars({ view }: { view: BarsView }) {
  return (
    <section className="stats__top" aria-label={view.title}>
      <h3>{view.title}</h3>
      <div className={`stats__bars${view.labelled ? "" : " stats__bars--dense"}`}>
        {view.bars.map((bar) => (
          <span key={bar.label} title={bar.title}>
            <i style={{ height: `${bar.height * 100}%` }} />
            {view.labelled && <small>{bar.label}</small>}
          </span>
        ))}
      </div>
    </section>
  );
}
