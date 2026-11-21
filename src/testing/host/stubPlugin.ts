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
  isJsonRecord,
  jsonl,
  parseInstant,
  type AgentLiveSession,
  type AgentStatus,
  type AgentStatusEvent,
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

/** The stub's usage report: how full its context is, and of which
 * conversation, when it says — through the bridge, or as a record of its
 * conversation's file the tailer carried. */
function stubUsage(payload: unknown, at: number): NormalizedUsage | null {
  const report = carriedUsageRecord(payload) ?? payload;
  if (!isJsonRecord(report) || typeof report.usedPct !== "number") return null;
  const sessionId = typeof report.sessionId === "string" ? report.sessionId : undefined;
  return { account: null, pane: { agent: STUB_AGENT, reportedAt: at, context: { usedPct: report.usedPct }, ...(sessionId !== undefined && { sessionId }) } };
}

/** One line of a stub conversation's file. */
interface StubRecord extends StubSaid {
  type?: unknown;
  at?: unknown;
}

function isStubRecord(value: unknown): value is StubRecord {
  return isJsonRecord(value);
}

/** What the stub's file says of its turns: a `status` record carries an edge
 * at its own time, in the words of the activation reading it; a `usage`
 * record is the numbers' lane, not this one. */
const stubTail = (turnStart: string): SessionTailDialect<JsonlRequest, StubRecord> => ({
  format: jsonl(isStubRecord),
  watches: [{ match: [{ key: "type", equals: "status" }], keep: ["type", "event", "reason", "at"], lane: "status" }],
  // The agent names its file in its binding: nothing is searched for.
  follow: async (pane) => (pane.store ? { path: pane.store } : null),
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
    // An agent's bin is run only under an exec capability that names it.
    capabilities: [{ kind: "exec", commands: ["node"] }],
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
            { id: "usage.pane", label: "Session analytics", group: "usage" },
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
    output.args = [program, ...args, "--store", control.storeDir, ...(control.deaf ? ["--deaf"] : []), ...(control.unbound ? ["--unbound"] : [])];
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
      const tail = stubTail(turnStart);
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
        // The stub CLI's words for a session that continues the pane's
        // conversation rather than starting one.
        binding: { swapSources: ["resume", "clear", "fork"] },
        // The numbers come through the bridge, or as `usage` records of the
        // conversation's file.
        usage: {
          normalize: stubUsage,
          tail: { watches: [{ match: [{ key: "type", equals: "usage" }], keep: ["type", "usedPct", "sessionId"], lane: "usage" }] },
        },
        // A companion in its process, once it says hello, states the file's
        // status facts itself: the tail then carries the numbers alone.
        companion: { covers: ["status-records"] },
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
