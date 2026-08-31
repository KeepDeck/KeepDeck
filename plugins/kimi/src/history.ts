import {
  jsonl,
  textFromParts,
  walkSession,
  type AgentHistory,
  type AgentSessionStub,
  type AgentTranscriptEntry,
  type FsEntry,
  type PluginContext,
  type SessionDialect,
} from "@keepdeck/plugin-api";

/**
 * Discovery over kimi's store ([F8] browser): sessions live at
 * `~/.kimi-code/sessions/wd_<key>/session_<id>/` — `state.json` carries
 * workDir + title, `agents/main/wire.jsonl` is the conversation. The wire
 * file is the change fingerprint (a dir's mtime doesn't move when a child
 * file grows). Read-only via `fs`.
 */
const ROOT = "~/.kimi-code/sessions";

/** One wire line, as this plugin reads it. An assertion about the format
 * made in ONE place: the host parses the JSON and validates nothing. */
interface KimiRecord {
  type?: unknown;
  message?: { role?: unknown; content?: unknown };
  event?: { type?: unknown; part?: { type?: unknown; text?: unknown } };
  input?: unknown;
  origin?: { kind?: unknown };
}

/** The assistant's text, still arriving.
 *
 * This is the only dialect on any agent that holds an UNFINISHED turn, and
 * the reason is the format: kimi writes the assistant's answer as it is
 * generated, one fragment per step, with tool calls in between. No record
 * says "the answer ended" — the only sign is the next user message. So the
 * fragments have to be held until one arrives, or the viewer would show a
 * single answer chopped into pieces wherever the assistant reached for a
 * tool. */
interface KimiState {
  assistant: string[];
}

/** The held fragments as one turn, and the buffer emptied. Fragments belong
 * to distinct steps, so they join with a newline. */
function flush(state: KimiState): AgentTranscriptEntry[] {
  const text = state.assistant.join("\n").trim();
  state.assistant = [];
  return text ? [{ role: "assistant", text }] : [];
}

/** Wire lines carry a conversation in THREE shapes (verified against a real
 * kimi store, and re-verified on 0.39):
 * - the USER's turn-opening messages are whole `context.append_message`
 *   events with a text-part content array;
 * - the USER's MID-TURN interjections are `turn.steer` events with an
 *   `input` part array — but only when `origin.kind` is "user"; the same
 *   event type also delivers background-task notifications and skill
 *   activations, which are framework noise;
 * - the ASSISTANT's text streams as `context.append_loop_event` events of
 *   inner type `content.part`, one PER STEP — never as append_message.
 * Tool calls, thinking and usage are not conversation text. */
const dialect: SessionDialect<KimiState, KimiRecord> = {
  begin: () => ({ assistant: [] }),

  step(state, record) {
    if (record.type === "context.append_loop_event") {
      const part = record.event?.type === "content.part" ? record.event.part : null;
      if (part?.type === "text" && typeof part.text === "string") {
        state.assistant.push(part.text);
      }
      return [];
    }
    if (record.type === "turn.steer") {
      if (record.origin?.kind !== "user") return [];
      const held = flush(state);
      const text = textFromParts(record.input).trim();
      return text ? [...held, { role: "user", text }] : held;
    }
    if (record.type !== "context.append_message") return [];
    const held = flush(state);
    const role = record.message?.role;
    const text = textFromParts(record.message?.content).trim();
    if (!text) return held;
    return [
      ...held,
      {
        role: role === "user" ? "user" : role === "assistant" ? "assistant" : "other",
        text,
      },
    ];
  },

  // The ONE non-empty end among all the agents. A read that stops without it
  // loses the conversation's last answer — with no error and no mark, only a
  // diff against the old output would ever show it missing. The walk calls
  // this on every exit, so it cannot be forgotten by whoever writes next.
  end: flush,
};

const WIRE_SUFFIX = "/agents/main/wire.jsonl";

/** The log line needs a string; whatever the fs layer threw becomes one. */
function errOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function kimiHistory(ctx: PluginContext): AgentHistory {
  const readSession = (
    ref: string,
    extra: { keep?: { offset: number; limit: number } } = {},
  ) =>
    walkSession({
      store: ctx.services.sessionStore,
      format: jsonl<KimiRecord>(),
      request: { path: ref },
      dialect,
      ...extra,
    });

  /** One page of turns WITH what the reading fell short by. */
  const readPage = async (
    ref: string,
    page: { offset: number; limit: number },
  ) => {
    const walked = await readSession(ref, { keep: page });
    return {
      entries: walked.turns,
      ...(walked.shortfall ? { shortfall: walked.shortfall } : {}),
    };
  };

  /** One working dir's `session_*` folders, walked — shared by both
   * enumeration contracts; they differ only in what they can SAY about the
   * `unreadable` names, everything else is common. */
  interface SessionWalk {
    stubs: AgentSessionStub[];
    /** Sessions whose `agents/main` exists but would not read — named, so
     * each contract answers with the honesty it can express: `listing()`
     * says "incomplete", `list()` refuses. */
    unreadable: string[];
  }

  const stubsOfSessions = async (sessions: FsEntry[]): Promise<SessionWalk> => {
    const stubs: AgentSessionStub[] = [];
    const unreadable: string[] = [];
    for (const session of sessions) {
      if (session.kind !== "dir" || !session.name.startsWith("session_"))
        continue;
      let main: FsEntry[];
      try {
        main = await ctx.services.fs.readDir(`${session.path}/agents/main`);
      } catch {
        // `agents/main` would not read. A session created and never spawned
        // has no `agents/main` AT ALL — a routine shape — and the fs
        // contract reports absent and unreadable with one message. A
        // PARENT LISTING is the fact that tells them apart without error
        // kinds, and absence is provable at every level the same way:
        // existence is visible from `agents/` even when `main` itself
        // refuses to open, and `agents/` itself is visible from the
        // SESSION dir even when `agents/` refuses.
        let agents: FsEntry[] | null = null;
        try {
          agents = await ctx.services.fs.readDir(`${session.path}/agents`);
        } catch {
          // `agents/` would not read either. It may simply not exist — a
          // session can be created before any agent dir is — so probe the
          // session dir itself before calling this unreadable.
          try {
            const sessionEntries = await ctx.services.fs.readDir(session.path);
            if (!sessionEntries.some((e) => e.name === "agents")) {
              continue; // genuinely no agents yet — routine, walk stays complete
            }
          } catch {
            // The session dir itself would not read: existence of
            // `agents/` unknowable — the honest direction is unreadable.
          }
        }
        if (agents !== null && !agents.some((e) => e.name === "main")) {
          continue; // never spawned — nothing to index, walk stays complete
        }
        // `agents/main` exists (or no readable parent can say otherwise)
        // but will not read. A stub of EXISTENCE keeps the session in the
        // scanner's sight — and so in the index — instead of letting it
        // fall out as "gone" while the walk claims to be complete; the
        // name goes upstairs for the incompleteness each contract owes
        // its reader.
        unreadable.push(session.name);
        stubs.push({
          sessionId: session.name,
          ref: `${session.path}/agents/main/wire.jsonl`,
          // The session DIRECTORY's time, and a size the store never wrote
          // for a live wire: the pair cannot equal a previously indexed
          // fingerprint, so the scanner re-asks this session every pass —
          // its describe refuses until the file reads again, which holds
          // pruning off rather than silently keeping stale content.
          mtime: session.mtime ?? 0,
          size: 0,
        });
        continue;
      }
      const wire = main.find((f) => f.name === "wire.jsonl");
      if (!wire) continue; // never messaged — nothing to index
      stubs.push({
        sessionId: session.name,
        ref: wire.path,
        mtime: wire.mtime ?? 0,
        size: wire.size ?? 0,
      });
    }
    return { stubs, unreadable };
  };
  return {
    async list(): Promise<AgentSessionStub[]> {
      const stubs: AgentSessionStub[] = [];
      const unreadable: string[] = [];
      let wdDirs;
      try {
        wdDirs = await ctx.services.fs.readDir(ROOT);
      } catch {
        return [];
      }
      for (const wd of wdDirs) {
        if (wd.kind !== "dir" || !wd.name.startsWith("wd_")) continue;
        // No catch: the store exists, so an unreadable working-dir folder is
        // a failure — a partial listing reads as "those sessions were
        // deleted" and the index prune acts on it. The scanner's per-agent
        // catch logs it and prunes nothing.
        const sessions = await ctx.services.fs.readDir(wd.path);
        const walked = await stubsOfSessions(sessions);
        stubs.push(...walked.stubs);
        unreadable.push(...walked.unreadable);
      }
      // This contract has no way to say "partial" — that is what `listing`
      // is for — so a session it could not read honestly is a refusal.
      // Answering with the stubs that did arrive would be read as the whole
      // store, and the unreadable session would be pruned as "gone".
      //
      // OUTSIDE the root catch above on purpose: inside, the "no store" arm
      // would swallow it and answer `[]` — the same lie wearing a shorter
      // list.
      if (unreadable.length > 0) {
        throw new Error(
          `kimi: ${unreadable.length} session(s) unreadable (${unreadable.join(", ")}) — use listing()`,
        );
      }
      return stubs;
    },
    /** The partial-tolerant twin of `list()` above: an unreadable
     * working-dir folder — or a session whose `agents/main` exists but
     * will not read — is kept out of nobody's sight, NAMED in the log,
     * and the answer says so with `complete: false`; the host then
     * indexes what it got and prunes nothing. */
    async listing(): Promise<{ stubs: AgentSessionStub[]; complete: boolean }> {
      const stubs: AgentSessionStub[] = [];
      const unreadable: string[] = [];
      let wdDirs;
      try {
        wdDirs = await ctx.services.fs.readDir(ROOT);
      } catch (e) {
        // A root refusal is NOT an empty store: [] with complete:true
        // would read as "every session deleted" and the host's prune
        // would wipe this agent's whole index. Nothing read, incomplete.
        ctx.log.warn(
          `kimi: store root unreadable (${errOf(e)}) — nothing enumerated`,
        );
        return { stubs, complete: false };
      }
      let complete = true;
      for (const wd of wdDirs) {
        if (wd.kind !== "dir" || !wd.name.startsWith("wd_")) continue;
        let sessions;
        try {
          sessions = await ctx.services.fs.readDir(wd.path);
        } catch (e) {
          // A partial answer must be a NAMED one — this folder stays
          // invisible to the index until it reads again, and silent
          // degradation is the one mode this contract forbids.
          complete = false;
          ctx.log.warn(
            `kimi: partial listing — ${wd.path} unreadable (${errOf(e)})`,
          );
          continue;
        }
        const walked = await stubsOfSessions(sessions);
        stubs.push(...walked.stubs);
        unreadable.push(...walked.unreadable);
      }
      if (unreadable.length > 0) {
        // A session the listing NAMED exists but its transcript would not
        // read: the stub above keeps its row in the index, and this says
        // the walk is not the whole store — so the host prunes nothing.
        complete = false;
        ctx.log.warn(
          `kimi: ${unreadable.length} session(s) with unreadable agents/main — listing incomplete: ${unreadable.join(", ")}`,
        );
      }
      return { stubs, complete };
    },
    async describe(ref) {
      const sessionDir = ref.endsWith(WIRE_SUFFIX)
        ? ref.slice(0, -WIRE_SUFFIX.length)
        : ref;
      const state = await ctx.services.fs
        .readFile(`${sessionDir}/state.json`)
        .catch(() => null);
      try {
        const parsed = JSON.parse(state?.text ?? "") as {
          cwd?: unknown;
          workDir?: unknown;
          title?: unknown;
        };
        // The working directory moved key: sessions written since kimi 0.38
        // carry `cwd`, older ones `workDir`. Reading only the old name left
        // every recent session unattached to its folder in the browser.
        const dir = typeof parsed.cwd === "string" ? parsed.cwd : parsed.workDir;
        return {
          cwd: typeof dir === "string" ? dir : "",
          ...(typeof parsed.title === "string" &&
            parsed.title !== "" && { title: parsed.title.slice(0, 120) }),
          transcriptPath: ref,
        };
      } catch {
        return { cwd: "", transcriptPath: ref };
      }
    },
    async content(ref) {
      // A role this dialect does not recognize is indexed like any other.
      // The index used to drop them while the transcript kept them — two
      // answers about one conversation, for a role that has never once
      // appeared in a real store. Keeping everything is both the simpler
      // code and the safer default: an unfamiliar role carrying real text is
      // likelier to be conversation we failed to name than noise, and
      // dropping it would lose it with nothing to show for the loss.
      return (await readSession(ref)).content;
    },
    // ONE reading, two contracts: the legacy method unpacks the honest one,
    // so the pair cannot drift.
    transcriptPage: readPage,
    async transcript(ref, page): Promise<AgentTranscriptEntry[]> {
      return (await readPage(ref, page)).entries;
    },
  };
}
