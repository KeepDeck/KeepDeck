import { useRef } from "react";
import { VirtualList } from "@keepdeck/ui-kit/VirtualList";
import type { WelcomeProjectRow, WelcomeView } from "../../presentation/welcomeView";

/**
 * The screen KeepDeck shows while it has no workspace: the greeting, the
 * one way in (a project folder), the words that name what it does, the
 * agents this machine has, and the projects agents have worked in. Dumb:
 * it draws `welcomeView` and emits intent.
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
  const list = useRef<HTMLDivElement>(null);
  // Show all… leaves with the press; the keyboard stays in the list, on
  // the first project it brought, rather than falling to the page.
  const showAll = () => {
    const shown = list.current?.querySelectorAll(".welcome__project").length ?? 0;
    onShowAll();
    requestAnimationFrame(() =>
      list.current?.querySelectorAll<HTMLButtonElement>(".welcome__project")[shown]?.focus(),
    );
  };
  return (
    <div className={view.className}>
      <section className="welcome__start">
        <h1 className="welcome__title">{view.title}</h1>
        <p className="welcome__pitch">{view.pitch}</p>
        <button type="button" className="form__create welcome__open" onClick={onOpenFolder}>
          {view.open}
        </button>
        <p className="welcome__hint">
          {view.hint} <kbd className="welcome__kbd">{view.shortcut}</kbd>
        </p>
        <ol className="welcome__steps">
          {view.steps.map((step) => (
            <li key={step.title}>
              <span>
                <b>{step.title}</b> — {step.text}
              </span>
            </li>
          ))}
        </ol>
        <p className="welcome__agents">
          {view.agents.label}
          {view.agents.items.map((agent) => (
            <span key={agent.name} className={agent.className}>
              {agent.name}
            </span>
          ))}
        </p>
      </section>
      {view.recent && (
        <section className="welcome__recent" aria-label={view.recent.heading}>
          <h2 className="welcome__recent-heading">
            {view.recent.heading} <span>{view.recent.caption}</span>
          </h2>
          <div className="welcome__list" ref={list}>
            <VirtualList
              items={view.recent.rows}
              itemKey={(row) => row.key}
              estimate={view.recent.rowEstimate}
              className="welcome__projects"
              ariaLabel={view.recent.heading}
              render={(row) => <ProjectRow row={row} onChoose={onChoose} />}
            />
            {view.recent.more && (
              <button type="button" className="welcome__more" onClick={showAll}>
                {view.recent.more}
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function ProjectRow({ row, onChoose }: { row: WelcomeProjectRow; onChoose(dir: string): void }) {
  return (
    <button type="button" className="welcome__project" title={row.dir} onClick={() => onChoose(row.dir)}>
      <span className="welcome__project-name">{row.name}</span>
      <span className="welcome__project-meta">
        {row.sessions} · {row.age}
      </span>
      <span className="welcome__project-path">
        <span>{row.path}</span>
      </span>
    </button>
  );
}
