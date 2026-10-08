import { VirtualList } from "@keepdeck/ui-kit/VirtualList";
import type { WelcomeProjectRow, WelcomeView } from "../../presentation/welcomeView";

/** First-paint height of a project row: two lines and its padding. */
const ROW_ESTIMATE_PX = 52;

/**
 * The screen KeepDeck shows while it has no workspace: the greeting, the
 * one way in (a project folder), the words that name what it does, the
 * agents found, and the projects agents have worked in. Dumb: it draws
 * `welcomeView` and emits intent.
 */
export function WelcomeScreen({
  view,
  onOpenFolder,
  onChoose,
  onShowAll,
}: {
  view: WelcomeView;
  onOpenFolder(): void;
  onChoose(dir: string): void;
  onShowAll(): void;
}) {
  return (
    <div className={view.recent ? "welcome welcome--with-recent" : "welcome"}>
      <section className="welcome__start">
        <h1 className="welcome__title">{view.title}</h1>
        <p className="welcome__pitch">{view.pitch}</p>
        <button type="button" className="form__create welcome__open" onClick={onOpenFolder}>
          {view.open}
        </button>
        <p className="welcome__hint">{view.hint}</p>
        <ol className="welcome__steps">
          {view.steps.map((step) => (
            <li key={step.title}>
              <b>{step.title}</b> — {step.text}
            </li>
          ))}
        </ol>
        <p className="welcome__agents">
          {view.agents.label}
          {view.agents.names?.map((name) => (
            <span key={name} className="kd-tag kd-tag--outline welcome__agent">
              {name}
            </span>
          ))}
        </p>
      </section>
      {view.recent && (
        <section className="welcome__recent" aria-label={view.recent.heading}>
          <h2 className="welcome__recent-heading">
            {view.recent.heading} <span>{view.recent.caption}</span>
          </h2>
          <VirtualList
            items={view.recent.rows}
            itemKey={(row) => row.key}
            estimate={ROW_ESTIMATE_PX}
            className="welcome__projects"
            ariaLabel={view.recent.heading}
            render={(row) => <ProjectRow row={row} onChoose={onChoose} />}
          />
          {view.recent.more && (
            <button type="button" className="welcome__more" onClick={onShowAll}>
              {view.recent.more}
            </button>
          )}
        </section>
      )}
    </div>
  );
}

function ProjectRow({ row, onChoose }: { row: WelcomeProjectRow; onChoose(dir: string): void }) {
  return (
    <button type="button" className="welcome__project" title={row.path} onClick={() => onChoose(row.dir)}>
      <span className="welcome__project-name">{row.name}</span>
      <span className="welcome__project-meta">
        {row.sessions} · {row.age}
      </span>
      <span className="welcome__project-path">{row.path}</span>
    </button>
  );
}
