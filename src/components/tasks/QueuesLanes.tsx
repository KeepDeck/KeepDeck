import type { QueueLaneView } from "../../presentation/tasks";
import { TaskCard } from "./TaskCard";

interface QueuesLanesProps {
  lanes: QueueLaneView[];
  selectedId: string | null;
  onSelect(id: string): void;
}

export function QueuesLanes({ lanes, selectedId, onSelect }: QueuesLanesProps) {
  return (
    <div className="tasks__lanes">
      {lanes.map((lane) => (
        <section key={lane.key} className={`tasks__lane${lane.isPool ? " tasks__lane--pool" : ""}`} aria-label={lane.name}>
          <header className="tasks__lane-head">
            <span className="tasks__lane-name">{lane.name}</span>
            <span className="tasks__lane-summary">{lane.summary}</span>
          </header>
          <div className="tasks__lane-body">
            {!lane.isPool && (
              <div className="tasks__lane-current">
                <span className="tasks__lane-caption">Current</span>
                {lane.current ? (
                  <TaskCard card={lane.current} selected={lane.current.id === selectedId} onSelect={onSelect} />
                ) : (
                  <span className="tasks__lane-idle">{lane.idleText}</span>
                )}
              </div>
            )}
            <div className="tasks__lane-queue">
              <span className="tasks__lane-caption">{lane.isPool ? "Next up — anyone on the team can take it" : "Next up"}</span>
              {lane.queued.map((card) => (
                <TaskCard key={card.id} card={card} selected={card.id === selectedId} onSelect={onSelect} />
              ))}
              {lane.queueEmptyText && <span className="tasks__lane-idle">{lane.queueEmptyText}</span>}
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
