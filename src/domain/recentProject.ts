/** One project agents have worked in on this machine: its folder — the
 * main checkout, for a repository, its worktrees and subfolders counted in
 * — how many sessions ran in it, and when the newest did (ms). Gathered by
 * the native side from the session index (`recent_projects`), newest first. */
export interface RecentProject {
  root: string;
  sessions: number;
  lastAt: number;
}

/** The list as the native side answers it: the projects, and the home
 * folder their paths may be shown under (`~`). */
export interface RecentProjects {
  home: string | null;
  projects: RecentProject[];
}
