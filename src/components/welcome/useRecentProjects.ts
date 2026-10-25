import { useEffect, useState, useSyncExternalStore } from "react";
import { useRuntimePart } from "../../app/runtimeContext";
import type { RecentProjects } from "../../domain/recentProject";
import { recentProjects } from "../../ipc/history";
import { log } from "../../ipc/log";
import { errorMessage } from "@keepdeck/plugin-api";

/**
 * The projects agents have worked in, as fresh as the session index: the
 * screen declares its need through the index's one owner (a full sweep,
 * as the sessions browser does) and asks again on each revision it
 * publishes — a first-ever scan fills the list batch by batch.
 */
const NONE: RecentProjects = { home: null, projects: [] };

export function useRecentProjects(): RecentProjects {
  const sessionIndex = useRuntimePart("sessionIndex");
  useEffect(() => sessionIndex.ensureFresh(), [sessionIndex]);
  const { revision } = useSyncExternalStore(sessionIndex.subscribe, sessionIndex.snapshot);
  const [projects, setProjects] = useState<RecentProjects>(NONE);
  useEffect(() => {
    let live = true;
    recentProjects().then(
      (next) => {
        if (live) setProjects(next);
      },
      (e) => log.warn("web:welcome", `recent_projects failed: ${errorMessage(e)}`),
    );
    return () => {
      live = false;
    };
  }, [revision]);
  return projects;
}
