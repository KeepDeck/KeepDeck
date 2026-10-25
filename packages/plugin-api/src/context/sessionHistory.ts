/**
 * An agent's session history, written once.
 *
 * Every agent answers the same contract — a stat-level enumeration in two
 * honesties (`list` and `listing`), a session's facts, its corpus, and its
 * transcript a page at a time — and every one had grown its own copy of the
 * parts that are not about its store: what an unreadable root means, what a
 * partly readable store owes each contract, how a refusal is logged, and the
 * page reading the legacy `transcript` must agree with. Those live here. A
 * plugin supplies only its [`SessionStore`]: how ITS sessions are found and
 * read, file tree or database alike.
 */
import { errorMessage } from "./authoring.ts";
import type {
  AgentHistory,
  AgentSessionFacts,
  AgentSessionStub,
  AgentTranscriptEntry,
  Shortfall,
} from "./agents.ts";
import type { FsEntry, PluginFs } from "./services.ts";
import type { PluginLogger } from "./log.ts";
import type { WalkedSession } from "./sessionWalk.ts";

/** One transcript page and what its reading fell short by. */
export interface TranscriptPage {
  entries: AgentTranscriptEntry[];
  shortfall?: Shortfall[];
}

/** One agent's store, as only that agent can read it. */
export interface SessionStore {
  /**
   * Every session the store holds, stat-level — no content read.
   *
   * THROWS when the store itself cannot be read: that is not an empty store,
   * and the two contracts answer it differently. A PART of the store that
   * will not read (a folder, a session, a query the host cut short) is
   * reported through `unreadable` and the walk goes on; a stub the store can
   * still name for it may be returned, which keeps it in the index.
   */
  enumerate(
    unreadable: (part: string, error?: unknown) => void,
  ): Promise<AgentSessionStub[]>;
  describe(ref: string): Promise<AgentSessionFacts>;
  content(ref: string): Promise<string>;
  readPage(ref: string, page: { offset: number; limit: number }): Promise<TranscriptPage>;
}

/** The whole history contract over one agent's store. `agent` names the
 * agent in the log lines a partial store owes its reader. */
export function sessionHistory(
  agent: string,
  log: PluginLogger,
  store: SessionStore,
): AgentHistory {
  return {
    /** The strict contract: it has no way to say "partial", so a store that
     * read only in part is a REFUSAL — the stubs that did arrive would be
     * read as the whole store, and everything missing pruned as gone. A
     * store that is not there at all is empty: the agent never ran here. */
    async list() {
      const parts: string[] = [];
      let stubs: AgentSessionStub[];
      try {
        stubs = await store.enumerate((part) => parts.push(part));
      } catch {
        return [];
      }
      if (parts.length > 0) {
        throw new Error(
          `${agent}: ${parts.length} part(s) of the store unreadable (${parts.join(", ")}) — use listing()`,
        );
      }
      return stubs;
    },
    /** The partial-tolerant twin: what read is indexed, what did not is
     * NAMED in the log, and `complete: false` keeps the host from pruning.
     * A root refusal is not an empty store either — `[]` with
     * `complete: true` would read as "every session deleted". (Accepted
     * cost: the fs layer says "no store" and "unreadable root" the same way,
     * so a store really deleted stops being pruned.) */
    async listing() {
      let complete = true;
      try {
        const stubs = await store.enumerate((part, error) => {
          complete = false;
          log.warn(
            `${agent}: partial listing — ${part} unreadable${
              error === undefined ? "" : ` (${errorMessage(error)})`
            }`,
          );
        });
        return { stubs, complete };
      } catch (error) {
        log.warn(`${agent}: store root unreadable (${errorMessage(error)}) — nothing enumerated`);
        return { stubs: [], complete: false };
      }
    },
    describe: (ref) => store.describe(ref),
    content: (ref) => store.content(ref),
    // ONE reading, two contracts: the legacy method unpacks the honest one,
    // so the pair cannot drift.
    transcriptPage: (ref, page) => store.readPage(ref, page),
    async transcript(ref, page) {
      return (await store.readPage(ref, page)).entries;
    },
  };
}

/** A walked page as the contract carries it. */
export function pageOfWalk(walked: WalkedSession<unknown>): TranscriptPage {
  return {
    entries: walked.turns,
    ...(walked.shortfall ? { shortfall: walked.shortfall } : {}),
  };
}

/** One directory's children for an enumeration: the entries, or null after
 * reporting the directory as an unreadable part. */
export async function readStoreDir(
  fs: Pick<PluginFs, "readDir">,
  path: string,
  unreadable: (part: string, error?: unknown) => void,
): Promise<FsEntry[] | null> {
  try {
    return await fs.readDir(path);
  } catch (error) {
    unreadable(path, error);
    return null;
  }
}

/** A session stub for one store file: the file is the ref, and its stat is
 * the change fingerprint. */
export function fileStub(sessionId: string, file: FsEntry): AgentSessionStub {
  return {
    sessionId,
    ref: file.path,
    mtime: file.mtime ?? 0,
    size: file.size ?? 0,
  };
}
