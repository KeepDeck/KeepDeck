import {
  fileStub,
  isJsonRecord,
  jsonl,
  pageOfWalk,
  readStoreDir,
  sessionHistory,
  textFromParts,
  titleText,
  transcriptRole,
  walkSession,
  type AgentHistory,
  type AgentSessionStub,
  type AgentTranscriptEntry,
  type FsEntry,
  type PluginEnv,
  type PluginFs,
  type PluginLogger,
  type PluginSessionStore,
  type SessionDialect,
} from "@keepdeck/plugin-api";
import { kimiHome } from "./home";

/**
 * Discovery over kimi's store ([F8] browser): sessions live at
 * `<kimi home>/sessions/wd_<key>/session_<id>/` — `state.json` carries
 * workDir + title, `agents/main/wire.jsonl` is the conversation. The wire
 * file is the change fingerprint (a dir's mtime doesn't move when a child
 * file grows). Read-only via `fs`. The home is kimi's own rule
 * (`KIMI_CODE_HOME`, else `~/.kimi-code`), read once per walk.
 */

/** One wire line, as this plugin reads it. The host parses the JSON and
 * validates nothing. */
interface KimiRecord {
  type?: unknown;
  message?: { role?: unknown; content?: unknown };
  event?: { type?: unknown; part?: { type?: unknown; text?: unknown } };
  input?: unknown;
  origin?: { kind?: unknown };
}

/** A JSON object whose `message`, `event` (and its `part`) and `origin`,
 * where present, are objects too. */
function isKimiRecord(value: unknown): value is KimiRecord {
  const objectOrAbsent = (field: unknown) => field === undefined || isJsonRecord(field);
  return (
    isJsonRecord(value) &&
    objectOrAbsent(value.message) &&
    objectOrAbsent(value.origin) &&
    (value.event === undefined || (isJsonRecord(value.event) && objectOrAbsent(value.event.part)))
  );
}

/** The assistant's text, still arriving.
 *
 * This is the only dialect on any agent that holds an UNFINISHED turn, and
 * the reason is the format: kimi writes the assistant's answer as it is
 * generated, one fragment per step, with tool calls in between. So the
 * fragments are held until something says the answer ended, or the viewer
 * would show a single answer chopped into pieces wherever the assistant
 * reached for a tool.
 *
 * TWO things end it, and the second is the fallback. `turn.ended` is the
 * format's own boundary; the next user message is what closes a turn when
 * no such record was written — older CLIs wrote none, and a live session's
 * newest turn has not ended yet. (This comment used to say no record
 * existed at all. It does: 121 of them on a real store, with reasons
 * completed, cancelled and failed.) */
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
    if (record.type === "turn.ended") {
      // The format saying "the answer ended", so two answers in a row can
      // never glue into one. EVERY reason closes it — a real store shows
      // completed, cancelled and failed — because a cancelled or failed
      // answer is still what the assistant said, and it deserves to be its
      // own turn rather than a prefix of the next one. The record is a
      // boundary, not speech: it contributes no turn of its own, and an
      // empty buffer produces nothing (13 of the 121 arrive that way).
      return flush(state);
    }
    if (record.type !== "context.append_message") return [];
    const held = flush(state);
    const role = record.message?.role;
    const text = textFromParts(record.message?.content).trim();
    if (!text) return held;
    return [
      ...held,
      {
        role: transcriptRole(role),
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

/** What the history reads through: the store's folders and files, the
 * session reader over them, and the log. */
export interface HistoryPorts {
  log: PluginLogger;
  services: {
    fs: Pick<PluginFs, "readDir" | "readFile">;
    sessionStore: PluginSessionStore;
    env: PluginEnv;
  };
}

export function kimiHistory(ctx: HistoryPorts): AgentHistory {
  const readSession = (
    ref: string,
    extra: { keep?: { offset: number; limit: number } } = {},
  ) =>
    walkSession({
      store: ctx.services.sessionStore,
      format: jsonl(isKimiRecord),
      request: { path: ref },
      dialect,
      ...extra,
    });

  /** One working dir's `session_*` folders, walked. A session whose
   * `agents/main` exists but would not read is reported to `unreadable` —
   * each history contract answers that with the honesty it can express —
   * and still gets a stub, so the index keeps sight of it. */
  const stubsOfSessions = async (
    sessions: FsEntry[],
    unreadable: (part: string, error?: unknown) => void,
  ): Promise<AgentSessionStub[]> => {
    const stubs: AgentSessionStub[] = [];
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
        unreadable(`${session.name} (agents/main)`);
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
      stubs.push(fileStub(session.name, wire));
    }
    return stubs;
  };
  return sessionHistory("kimi", ctx.log, {
    async enumerate(unreadable) {
      const stubs: AgentSessionStub[] = [];
      const root = `${await kimiHome(ctx.services.env)}/sessions`;
      for (const wd of await ctx.services.fs.readDir(root)) {
        if (wd.kind !== "dir" || !wd.name.startsWith("wd_")) continue;
        const sessions = await readStoreDir(ctx.services.fs, wd.path, unreadable);
        if (sessions) stubs.push(...(await stubsOfSessions(sessions, unreadable)));
      }
      return stubs;
    },
    async describe(ref) {
      const sessionDir = ref.endsWith(WIRE_SUFFIX)
        ? ref.slice(0, -WIRE_SUFFIX.length)
        : ref;
      const state = await ctx.services.fs
        .readFile(`${sessionDir}/state.json`)
        .catch(() => null);
      try {
        const read: unknown = JSON.parse(state?.text ?? "");
        // Not an object: the session's details are unknown, as for a file
        // that does not parse.
        if (!isJsonRecord(read)) return { cwd: "", transcriptPath: ref };
        const parsed = read;
        // The working directory moved key: sessions written since kimi 0.38
        // carry `cwd`, older ones `workDir`. Reading only the old name left
        // every recent session unattached to its folder in the browser.
        const dir = typeof parsed.cwd === "string" ? parsed.cwd : parsed.workDir;
        return {
          cwd: typeof dir === "string" ? dir : "",
          ...(typeof parsed.title === "string" &&
            parsed.title !== "" && { title: titleText(parsed.title) }),
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
    readPage: async (ref, page) => pageOfWalk(await readSession(ref, { keep: page })),
  });
}
