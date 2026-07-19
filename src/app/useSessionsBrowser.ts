import { useCallback, useRef, useState } from "react";
import type { AgentTranscriptEntry } from "@keepdeck/plugin-api";
import { indexSearch, type SearchHit } from "../ipc/history";
import { describeError, log } from "../ipc/log";
import { scanAgentHistories } from "./historyScan";
import { useAppRuntime } from "./runtimeContext";

export interface SessionsBrowserApi {
  /** Hits for the current query (empty query = newest sessions). */
  hits: SearchHit[];
  scanning: boolean;
  /** Run the debounced search; called on every keystroke. */
  search(query: string): void;
  /** Incremental store scan, then refresh the current results. Safe to call
   * on browser mount — only new/changed sessions are opened. */
  scan(): void;
  /** One transcript page, via the owning plugin (live parse — the index
   * never renders transcripts). */
  transcript(
    agent: string,
    ref: string,
    offset: number,
    limit: number,
  ): Promise<AgentTranscriptEntry[]>;
}

/** The global sessions browser's engine ([F8]): search-as-you-type hits the
 * Rust index only; scans and the viewer go through the agent plugins. */
export function useSessionsBrowser(): SessionsBrowserApi {
  const { plugins } = useAppRuntime();
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [scanning, setScanning] = useState(false);
  const queryRef = useRef("");
  const searchSeq = useRef(0);
  const debounce = useRef<number | null>(null);
  const scanningRef = useRef(false);

  const runSearch = useCallback((query: string) => {
    const seq = ++searchSeq.current;
    void indexSearch(query, 100)
      .then((rows) => {
        if (searchSeq.current === seq) setHits(rows);
      })
      .catch((e) =>
        log.warn("web:history", `search failed: ${describeError(e)}`),
      );
  }, []);

  const search = useCallback(
    (query: string) => {
      queryRef.current = query;
      if (debounce.current !== null) window.clearTimeout(debounce.current);
      debounce.current = window.setTimeout(() => runSearch(query), 150);
    },
    [runSearch],
  );

  const scan = useCallback(() => {
    if (scanningRef.current) return;
    scanningRef.current = true;
    setScanning(true);
    const sources = plugins.pluginRegistries.agents
      .list()
      .flatMap((c) =>
        c.entry.history
          ? [{ agentId: c.entry.id, history: c.entry.history }]
          : [],
      );
    void scanAgentHistories(sources)
      .catch((e) => log.warn("web:history", `scan failed: ${describeError(e)}`))
      .finally(() => {
        scanningRef.current = false;
        setScanning(false);
        runSearch(queryRef.current);
      });
  }, [plugins, runSearch]);

  const transcript = useCallback(
    async (agent: string, ref: string, offset: number, limit: number) => {
      const contribution = plugins.pluginRegistries.agents
        .list()
        .find((c) => c.entry.id === agent);
      if (!contribution?.entry.history) return [];
      return contribution.entry.history.transcript(ref, { offset, limit });
    },
    [plugins],
  );

  return { hits, scanning, search, scan, transcript };
}
