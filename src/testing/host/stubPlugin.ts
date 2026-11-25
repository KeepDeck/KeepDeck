// The test plugin the page runs with on the host: a plugin like any other —
// a manifest, an agent registered on activation, plans built by its hooks —
// whose agent is the stub program (stubAgent.mjs). So the page's spawn plans
// are built for real, the bridge armed by the real plan builder, and nothing
// depends on the CLIs this machine happens to have.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  API_VERSION,
  carriedUsageRecord,
  decodeStatusPayload,
  fileStub,
  isJsonRecord,
  jsonl,
  pageOfWalk,
  parseInstant,
  reportedLimits,
  sessionHistory,
  walkSession,
  type AccountUsage,
  type AgentHistory,
  type PluginContext,
  type SessionDialect,
  type LimitsRead,
  type UsageCall,
  type AgentLiveSession,
  type AgentStatus,
  type AgentStatusEvent,
  type AgentUsage,
  type JsonlRequest,
  type StatusWaitReason,
  type SessionTailDialect,
  type ForkPlanInput,
  type KeepDeckPlugin,
  type NormalizedUsage,
  type PluginManifest,
  type PluginSessions,
  type ResumePlanInput,
  type SpawnPlanInput,
  type SpawnPlanOutput,
} from "@keepdeck/plugin-api";
import { inject } from "vitest";
import type { PluginInstall } from "../../plugins/host/host";

/** The agent type a host test's panes run. */
export const STUB_AGENT = "stub";

/** The stub plugin's own id. */
export const STUB_PLUGIN_ID = "keepdeck.test-stub";

/** One plan a hook of the stub plugin was asked for, as the page asked it —
 * and whether the folder it is for stood when it was asked. */
export type StubPlan =
  | { hook: "spawn" | "resume"; input: SpawnPlanInput; folderStood: boolean }
  | { hook: "fork"; input: ForkPlanInput; folderStood: boolean };

/** What a test tells the stub agent's plans, read at each plan — and what
 * the plans were asked. */
export interface StubAgentControl {
  /** Every plan asked of the stub plugin's hooks, in order. */
  plans: StubPlan[];
  /** How many resumes, from the next, are refused: the agent exits at
   * once, having reported nothing. */
  rejectResumes: number;
  /** The registry of live sessions the plugin offers, fixed at its
   * activation: the stub processes' own files in `liveDir`, one that
   * cannot say (it refuses), or none at all. */
  liveRegistry: "files" | "fails" | "none";
  /** Where processes run outside the deck keep their live sessions. */
  liveDir: string;
  /** Forks are refused the same way: the fork never finishes. */
  rejectForks: boolean;
  /** A resume's plan cannot be built: its hook throws this, said as the
   * reason. */
  resumePlanFails: string | null;
  /** The agent ignores a polite stop: only the kill ends it. */
  deaf: boolean;
  /** The agent reports nothing at start — neither its conversation nor
   * itself at its prompt: what it reports is cued. */
  unbound: boolean;
  /** The agent, coming up, says it waits on a permission rather than that
   * it is at its prompt — from its terminal, as an agent's hook can before
   * the spawn's answer reaches the page. */
  startsWaiting: boolean;
  /** The agent can resume a recorded conversation: its manifest says so,
   * and its plugin has the hook. Read once, at activation. */
  resumes: boolean;
  /** Where the stub agents keep each conversation's file — the store the
   * deck's tailer follows, as a CLI's transcript. */
  storeDir: string;
  /** The process door the stub plugin was handed at activation — the app's
   * own, for a plugin's processes — once it is active. */
  sessions: PluginSessions | null;
  /** A spawn's plan cannot be built: its hook throws this, and the pane is
   * launched bare — the agent's bin, with no bridge to report through. */
  spawnPlanFails: string | null;
  /** The agent's program is gone from where its plans name it. */
  programGone: boolean;
  /** The agent declares no status: it reports none of its turns. Read at
   * activation. */
  voiceless: boolean;
  /** The word its hooks and its file say a turn starts with. Read at
   * activation: a plugin updated between two says it its new way. */
  turnStartWord: string;
  /** The agent keeps its conversation's file, and names it in its binding;
   * when it does not, it binds naming no file. */
  keepsStore: boolean;
  /** The agent declares a usage tail: which records of its file carry its
   * numbers. Read at activation. */
  tailed: boolean;
  /** Its account's limits source — the plugin's own fetch — or none. Read at
   * activation. */
  limitsRead: (() => Promise<LimitsRead>) | null;
  /** The files worth reading cold at boot for the account's state, newest
   * first, or none. Read at activation. */
  sweep: readonly string[] | null;
  /** How many times the plugin searched its store for a conversation's file. */
  lookups: number;
  /** While pending, each search waits on it. */
  lookupHeld: Promise<void> | null;
  /** Its searches find nothing: the CLI keeps its stores where its plugin
   * does not look. */
  lookupMisses: boolean;
  /** A companion in its process states its turns' records itself. Read at
   * activation. */
  covers: boolean;
  /** Its turns' records carry its calls too: a calls watch among its status
   * watches. Read at activation. */
  statusWatchesCalls: boolean;
  /** The agent can run with its permission prompts off: its manifest
   * declares YOLO. Read when the plugin is installed. */
  yolo: boolean;
  /** The agent declares its history: the conversations its store holds,
   * which the deck's index reads. Read when the plugin is installed. */
  history: boolean;
}

/** What a stub's status report or record says: an edge by its own name and,
 * for a wait or its end, why. */
interface StubSaid {
  event?: unknown;
  reason?: unknown;
}

const waitReason = (reason: unknown): StatusWaitReason | null => (reason === "permission" || reason === "question" ? reason : null);

/** The stub's words for its edges, as its hooks and its file say them — the
 * one place they are read, at `at`. A turn starts with `turnStart`: the word
 * of the activation reading it. */
function stubEvent(said: StubSaid, at: number, turnStart: string): AgentStatusEvent | null {
  if (said.event === turnStart) return { kind: "turn-start", at };
  switch (said.event) {
    case "ready":
    case "turn-end":
    case "context-compacted":
      return { kind: said.event, at };
    case "waiting": {
      const reason = waitReason(said.reason);
      return reason === null ? null : { kind: "waiting", at, reason };
    }
    case "resumed": {
      const reason = waitReason(said.reason);
      return reason === null ? { kind: "resumed", at } : { kind: "resumed", at, reason };
    }
    default:
      return null;
  }
}

/** The account a stub states — in a report, a record or a limits read: one
 * window, used this much, as of `at`. */
function stubAccount(limits: unknown, at: number): AccountUsage | null {
  if (!isJsonRecord(limits) || typeof limits.usedPct !== "number") return null;
  return reportedLimits([{ usedPct: limits.usedPct, resetsAt: null, windowMinutes: null }], at);
}

/** The calls a stub names, each by its id: one token each way, made at the
 * record's own time. */
function stubCalls(calls: unknown, at: number): UsageCall[] | undefined {
  if (!Array.isArray(calls)) return undefined;
  return calls
    .filter((id): id is string => typeof id === "string")
    .map((id) => ({ id, at, provider: "stub", model: "stub-1", tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } }));
}

/** The stub's usage report — through the bridge, or as a record of its
 * conversation's file the tailer carried: how full its context is and of
 * which conversation, the account's window, the calls it made, each when it
 * says. */
function stubUsage(payload: unknown, at: number): NormalizedUsage | null {
  const report = carriedUsageRecord(payload) ?? payload;
  if (!isJsonRecord(report)) return null;
  const sessionId = typeof report.sessionId === "string" ? report.sessionId : undefined;
  const pane = typeof report.usedPct === "number" ? { agent: STUB_AGENT, reportedAt: at, context: { usedPct: report.usedPct }, ...(sessionId !== undefined && { sessionId }) } : null;
  const account = stubAccount(report.limits, at);
  const calls = stubCalls(report.calls, at);
  // The other conversations' stores it names — a subagent's, say.
  const links = Array.isArray(report.links) ? report.links.filter((id): id is string => typeof id === "string") : undefined;
  if (!pane && !account && !calls && !links) return null;
  return { account, pane, ...(calls && { calls }), ...(links && { links }) };
}

/** One line of a stub conversation's file: an edge or numbers it reports,
 * the head naming the folder it ran in, or one of its turns. */
interface StubRecord extends StubSaid {
  type?: unknown;
  at?: unknown;
  cwd?: unknown;
  role?: unknown;
  text?: unknown;
}

function isStubRecord(value: unknown): value is StubRecord {
  return isJsonRecord(value);
}

/** What the stub's file says of its conversation, as its history reads it:
 * the folder its `session` head names, and its `turn`s. */
const historyDialect: SessionDialect<{ cwd?: string }, StubRecord> = {
  begin: () => ({}),
  step(state, record) {
    if (record.type === "session" && typeof record.cwd === "string") state.cwd ??= record.cwd;
    if (record.type !== "turn" || typeof record.text !== "string") return [];
    return record.role === "user" || record.role === "assistant" ? [{ role: record.role, text: record.text }] : [];
  },
  end: () => [],
};

/** The stub's history: every conversation file in its store, read through
 * the plugin's own services as a CLI's plugin reads its store. */
function stubHistory(ctx: Pick<PluginContext, "log" | "services">, storeDir: string): AgentHistory {
  const walk = (ref: string, keep?: { offset: number; limit: number }) =>
    walkSession({ store: ctx.services.sessionStore, format: jsonl(isStubRecord), request: { path: ref }, dialect: historyDialect, ...(keep && { keep }) });
  return sessionHistory(STUB_AGENT, ctx.log, {
    async enumerate() {
      // The store not there throws: a store that is not there is the core's to read.
      const files = await ctx.services.fs.readDir(storeDir);
      return files.flatMap((file) => (file.kind === "file" && file.name.endsWith(".jsonl") ? [fileStub(file.name.slice(0, -".jsonl".length), file)] : []));
    },
    async describe(ref) {
      const walked = await walk(ref);
      return { cwd: walked.state.cwd ?? "", title: walked.title, transcriptPath: ref, ...(walked.shortfall && { shortfall: walked.shortfall }) };
    },
    content: async (ref) => (await walk(ref)).content,
    readPage: async (ref, page) => pageOfWalk(await walk(ref, page)),
  });
}

/** What the stub's file says of its turns: a `status` record carries an edge
 * at its own time, in the words of the activation reading it; a `usage`
 * record is the numbers' lane, not this one. Its file is the one its binding
 * named — or, for a pane that has a conversation but named no file, the one
 * `find` finds for it, as a CLI's own store is searched. */
const stubTail = (turnStart: string, find: (sessionId: string) => Promise<string | null>, watchesCalls: boolean): SessionTailDialect<JsonlRequest, StubRecord> => ({
  format: jsonl(isStubRecord),
  watches: [
    { match: [{ key: "type", equals: "status" }], keep: ["type", "event", "reason", "at"], lane: "status" },
    // A dialect that reads its calls among its turns' records.
    ...(watchesCalls ? [{ match: [{ key: "type", equals: "call" }], keep: ["type", "calls"], lane: "calls" as const }] : []),
  ],
  follow: async (pane) => {
    if (pane.store) return { path: pane.store };
    const path = pane.sessionId ? await find(pane.sessionId) : null;
    return path ? { path } : null;
  },
  read: (record) => {
    const at = parseInstant(record.at);
    return at === null ? null : stubEvent(record, at, turnStart);
  },
  ignores: (record) => record.type === "usage",
});

/** The stub plugin, as the plugin manager installs a built-in. */
export function stubPlugin(control: StubAgentControl): PluginInstall {
  const program = inject("stubAgent");
  const manifest: PluginManifest = {
    id: STUB_PLUGIN_ID,
    name: "Stub agent",
    version: "1.0.0",
    minApiVersion: API_VERSION,
    category: "cli",
    description: "The agent of the page's tests on the host harness.",
    // An agent's bin is run only under an exec capability that names it; a
    // history reads its store under a read capability, as a CLI's does.
    capabilities: [{ kind: "exec", commands: ["node"] }, ...(control.history ? [{ kind: "fs" as const, scope: "everywhere" as const }] : [])],
    contributes: {
      agents: [
        {
          id: STUB_AGENT,
          label: "Stub",
          bin: "node",
          features: [
            { id: "session.new", label: "New sessions", group: "sessions" },
            ...(control.resumes ? [{ id: "session.resume", label: "Resume saved sessions", group: "sessions" }] : []),
            { id: "session.fork", label: "Fork saved sessions", group: "sessions" },
            ...(control.history ? [{ id: "session.history", label: "Session history", group: "sessions" }] : []),
            { id: "usage.pane", label: "Session analytics", group: "usage" },
            // An account limits source is declared under its feature.
            ...(control.limitsRead !== null ? [{ id: "usage.account", label: "Account limits", group: "usage" }] : []),
            ...(control.yolo ? [{ id: "execution.yolo", label: "YOLO mode", group: "execution" }] : []),
            // Its thin client runs here and attaches to an agent server.
            { id: "target.remote", label: "Remote targets", group: "execution", parameters: { schemes: ["ws"] } },
          ],
        },
      ],
    },
  };
  const run = (output: SpawnPlanOutput, args: string[]) => {
    // A program gone from where the plan names it: the spawn finds nothing.
    output.command = control.programGone ? join(control.storeDir, "gone", "node") : process.execPath;
    output.args = [program, ...args, ...(control.keepsStore ? ["--store", control.storeDir] : []), ...(control.deaf ? ["--deaf"] : []), ...(control.unbound ? ["--unbound"] : []), ...(control.startsWaiting ? ["--waiting"] : [])];
  };
  /** The stub's search of its own store for a conversation's file — what a
   * CLI's rollout search is — for a pane's own conversation and for one its
   * records name alike. It waits while the test holds it. */
  const find = async (sessionId: string): Promise<string | null> => {
    control.lookups += 1;
    await control.lookupHeld;
    const path = join(control.storeDir, `${sessionId}.jsonl`);
    return !control.lookupMisses && existsSync(path) ? path : null;
  };
  // The registry a CLI keeps of its own runs: read, never guessed — and
  // refusing, when it cannot say, rather than answering empty.
  const liveSessions = {
    list(): Promise<AgentLiveSession[]> {
      if (control.liveRegistry === "fails") return Promise.reject(new Error("the stub's registry cannot say"));
      const held = existsSync(control.liveDir) ? readdirSync(control.liveDir) : [];
      return Promise.resolve(held.map((sessionId) => ({ sessionId, kind: "interactive" })));
    },
  };
  const plugin: KeepDeckPlugin = {
    activate(ctx) {
      control.sessions = ctx.services.sessions;
      // What this activation says a turn starts with, and whether it speaks
      // of its turns at all: read once, as a plugin's version is.
      const turnStart = control.turnStartWord;
      const tail = stubTail(turnStart, find, control.statusWatchesCalls);
      // Its account's limits, read as the plugin's own fetch, and the files
      // worth reading cold at boot: what this activation declares.
      const limitsRead = control.limitsRead;
      const sweep = control.sweep;
      const usage: AgentUsage = {
        normalize: stubUsage,
        ...(control.tailed && {
          tail: {
            watches: [{ match: [{ key: "type", equals: "usage" }], keep: ["type", "usedPct", "sessionId", "limits", "calls", "links"], lane: "usage" }],
            // A store its records name is where its search finds it.
            locate: find,
            ...(sweep !== null && { sweep: () => Promise.resolve(sweep) }),
          },
        }),
        ...(limitsRead !== null && {
          limits: {
            read: limitsRead,
            normalize: (body, at) => {
              try {
                return stubAccount(JSON.parse(body), at);
              } catch {
                return null;
              }
            },
          },
        }),
      };
      const status: AgentStatus = {
        normalize: (payload, at) => {
          // A record of its file the host carried by this plugin's watch:
          // what it means is the dialect's, at the record's own time.
          const decoded = decodeStatusPayload(payload);
          if (decoded?.source === "record") return isStubRecord(decoded.record) ? tail.read(decoded.record) : null;
          return isJsonRecord(payload) ? stubEvent(payload, at, turnStart) : null;
        },
        attribute: (payload) => {
          if (decodeStatusPayload(payload)?.source === "record") return { event: null, actor: "main", status: true };
          // Which edge it names; its time is not read here.
          const edge = isJsonRecord(payload) ? stubEvent(payload, 0, turnStart) : null;
          return edge === null ? null : { event: edge.kind, actor: "main", status: true };
        },
        tail,
      };
      ctx.agents.register({
        id: STUB_AGENT,
        label: "Stub",
        detect: { bin: "node" },
        ...(control.liveRegistry !== "none" && { liveSessions }),
        ...(control.history && { history: stubHistory(ctx, control.storeDir) }),
        // The stub CLI's words for a session that continues the pane's
        // conversation rather than starting one.
        binding: { swapSources: ["resume", "clear", "fork"] },
        // The numbers come through the bridge, or as `usage` records of the
        // conversation's file.
        usage,
        // A companion in its process, once it says hello, states the file's
        // status facts itself: the tail then carries the numbers alone.
        ...(control.covers && { companion: { covers: ["status-records"] } }),
        ...(!control.voiceless && { status }),
        hooks: {
          "spawn.plan"(input, output) {
            control.plans.push({ hook: "spawn", input, folderStood: existsSync(input.cwd) });
            if (control.spawnPlanFails !== null) throw new Error(control.spawnPlanFails);
            run(output, []);
          },
          ...(control.resumes && {
            "resume.plan"(input: ResumePlanInput, output: SpawnPlanOutput) {
              control.plans.push({ hook: "resume", input, folderStood: existsSync(input.cwd) });
              if (control.resumePlanFails !== null) throw new Error(control.resumePlanFails);
              const reject = control.rejectResumes > 0;
              if (reject) control.rejectResumes -= 1;
              run(output, ["--resume", input.sessionId, ...(reject ? ["--reject"] : [])]);
            },
          }),
          // Its store is its own process: the fork copies nothing, so it
          // leaves nothing to take back.
          "fork.plan"(input, output) {
            control.plans.push({ hook: "fork", input, folderStood: existsSync(input.cwd) });
            run(output, ["--fork", input.sessionId, ...(control.rejectForks ? ["--reject"] : [])]);
          },
        },
      });
    },
  };
  return { manifest, load: () => Promise.resolve(plugin) };
}
