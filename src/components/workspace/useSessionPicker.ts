/**
 * The "Start from" picker's mind: which of the selected agent's recorded
 * sessions the new pane would continue, and whether it may.
 *
 * Its own hook because it is its own feature — a paged search over the
 * session index, a live index subscription, a directory-presence probe and an
 * outside-process query, four collaborators nothing else in the dialog
 * touches. What it does NOT own is the Name field: a pick suggests a title,
 * and the dialog decides what to do with it (`onPrefill`).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  AgentType,
  ResumeBlock,
  SessionPickRow,
  SessionStartMode,
} from "../../domain/agents";
import { normalizePath } from "../../domain/deck";
import { dirPresent, useDirPresence } from "../history/useDirPresence";
import { useScrollPaging } from "../../ui/useScrollPaging";
import { usePagedSessionSearch, type Page } from "../../app/usePagedSessionSearch";
import { useAppRuntime } from "../../app/runtimeContext";

export function useSessionPicker(deps: {
  agentType: AgentType;
  startMode: SessionStartMode;
  /** The team a member would join, when the dialog is for one. */
  member: { cwd: string | null } | null;
  searchSessions(
    agent: AgentType,
    query: string,
    limit: number,
    offset: number,
  ): Promise<Page<SessionPickRow>>;
  sessionClaim(sessionId: string): "running" | "stopped" | null;
  liveOutside(
    agent: AgentType,
  ): Promise<{ ok: true; ids: ReadonlySet<string> } | { ok: false }>;
  /** A pick's title, offered to the Name field. */
  onPrefill(title: string): void;
}) {
  const {
    agentType,
    startMode,
    member,
    searchSessions,
    sessionClaim,
    liveOutside,
    onPrefill,
  } = deps;
  const [sessionQuery, setSessionQuery] = useState("");
  const [picked, setPicked] = useState<SessionPickRow | null>(null);

  // The picker's options, paged through the SAME engine as the global browser
  // ([[usePagedSessionSearch]]) — the fetcher is scoped to the selected agent
  // and re-scopes when the user switches. Virtualization/paging were missing
  // here before: the list was capped at one page.
  const pagedSessions = usePagedSessionSearch<SessionPickRow>(
    useCallback(
      (query, limit, offset) =>
        searchSessions(agentType, query, limit, offset),
      [searchSessions, agentType],
    ),
  );
  const sessions = pagedSessions.rows;
  const listRef = useRef<HTMLUListElement | null>(null);
  const onSessionsScroll = useScrollPaging(
    listRef,
    pagedSessions,
    sessions.length,
  );

  // Re-query as the user types, switches agent, or opens resume/fork. Skipped
  // for "new" (no picker shown); the shared engine debounces and pages.
  const { search: searchSessionsPage } = pagedSessions;
  useEffect(() => {
    if (startMode === "new") return;
    searchSessionsPage(sessionQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startMode, agentType, sessionQuery]);

  // The picker reads the INDEX, which nothing refreshed unless the history
  // browser was visited. DECLARE the need for the selected agent's store —
  // when the scan runs is the sessionIndexManager's call (it waits for
  // plugin registration on its own). Fires on open and on every agent
  // switch; typing never rescans.
  const { sessionIndex } = useAppRuntime();
  useEffect(() => {
    sessionIndex.ensureFresh(agentType);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionIndex, agentType]);

  // The declared scan lands in BATCHES — the picker's listing re-reads its
  // page-zero span on every revision bump so a long first catch-up fills
  // the list while it runs (the browser's twin, same snapshot). The FIRST
  // observation only records the baseline: the mount query above already
  // lists, and a re-fetch before any rows landed would be a duplicate.
  const index = useSyncExternalStore(sessionIndex.subscribe, sessionIndex.snapshot);
  const lastRevision = useRef<number | null>(null);
  const { refresh: refreshSessions } = pagedSessions;
  useEffect(() => {
    const first = lastRevision.current === null;
    lastRevision.current = index.revision;
    if (first || startMode === "new") return;
    refreshSessions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index.revision]);

  // A pick belongs to ONE agent's store — switching agents voids it (and the
  // typed filter; the fresh listing shouldn't open pre-narrowed). An
  // auto-filled (untouched) name came from that pick's title, so drop it too.
  useEffect(() => {
    setPicked(null);
    setSessionQuery("");
    onPrefill("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentType]);

  // Resume needs the session's directory alive — same gate as the browser.
  const presenceCwds = useMemo(
    () => (startMode === "resume" ? sessions.map((s) => s.handle.cwd) : []),
    [startMode, sessions],
  );
  const presence = useDirPresence(presenceCwds);
  // Which sessions an OUTSIDE process holds, asked once per agent while a
  // resume picker is open — a second wave, never a delay to opening (the
  // registry costs a CLI spawn; the branch list arrives the same way).
  // `unknown` marks rows the registry could not speak to — blocked like a
  // busy row (resuming would just be refused), forkable like any other.
  const [liveOutsideIds, setLiveOutsideIds] = useState<ReadonlySet<string> | "unknown">("unknown");
  useEffect(() => {
    if (startMode !== "resume") return;
    let cancelled = false;
    setLiveOutsideIds("unknown");
    liveOutside(agentType).then((answer) => {
      if (cancelled) return;
      setLiveOutsideIds(answer.ok ? answer.ids : "unknown");
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startMode, agentType]);

  const resumeBlockOf = (row: SessionPickRow): ResumeBlock => {
    if (row.handle.cwd === "") return "no-cwd";
    if (sessionClaim(row.handle.sessionId) !== null) return "claimed";
    if (
      liveOutsideIds !== "unknown" &&
      liveOutsideIds.has(row.handle.sessionId)
    )
      return "busy-outside";
    if (!dirPresent(presence, row.handle.cwd)) return "dir-gone";
    // A member runs where its team runs: a session recorded anywhere else
    // resumes into another team. Forking it HERE is what the copy is for.
    // "The same directory" is the deck's key, not the raw strings: the
    // journal records "/repo/wt/" where the team holds "/repo/wt", and the
    // landing would put that resume on this team.
    if (
      member &&
      member.cwd !== null &&
      normalizePath(row.handle.cwd) !== normalizePath(member.cwd)
    )
      return "elsewhere";
    return null;
  };
  const blockReason = (block: ResumeBlock): string | null => {
    switch (block) {
      case "no-cwd":
        return "no recorded directory — fork instead";
      case "claimed":
        return "already in a pane";
      case "busy-outside":
        return "running in the background — fork a copy to continue here";
      case "dir-gone":
        return "directory is gone — fork instead";
      case "elsewhere":
        return "recorded in another directory — fork a copy into this team";
      case null:
        return null;
    }
  };

  const pickSession = (row: SessionPickRow) => {
    // Ignore a click on a row from a DIFFERENT agent than the selected one —
    // reachable only on a row still rendered from the previous agent during the
    // search debounce window. `validPick` already blocks it downstream; this
    // also stops the Name from prefilling off a pick that can't be used.
    if (row.handle.agent !== agentType) return;
    setPicked(row);
    onPrefill(row.handle.title ?? "");
  };

  return {
    sessionQuery,
    setSessionQuery,
    picked,
    pagedSessions,
    sessions,
    listRef,
    onSessionsScroll,
    resumeBlockOf,
    blockReason,
    pickSession,
  };
}
