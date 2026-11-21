// The test plugin the page runs with on the host: a plugin like any other —
// a manifest, an agent registered on activation, plans built by its hooks —
// whose agent is the stub program (stubAgent.mjs). So the page's spawn plans
// are built for real, the bridge armed by the real plan builder, and nothing
// depends on the CLIs this machine happens to have.
import { existsSync, readdirSync } from "node:fs";
import {
  API_VERSION,
  carriedUsageRecord,
  decodeStatusPayload,
  isJsonRecord,
  jsonl,
  parseInstant,
  type AgentLiveSession,
  type JsonlRequest,
  type SessionTailDialect,
  type ForkPlanInput,
  type KeepDeckPlugin,
  type NormalizedUsage,
  type PluginManifest,
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
}

/** The stub's own words in a status report: the edges its hooks say. */
const STATUS_EDGES = ["ready", "turn-start", "turn-end"] as const;

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
interface StubRecord {
  type?: unknown;
  event?: unknown;
  at?: unknown;
}

function isStubRecord(value: unknown): value is StubRecord {
  return isJsonRecord(value);
}

/** What the stub's file says of its turns: a `status` record carries an edge
 * at its own time; a `usage` record is the numbers' lane, not this one. */
const stubTail: SessionTailDialect<JsonlRequest, StubRecord> = {
  format: jsonl(isStubRecord),
  watches: [{ match: [{ key: "type", equals: "status" }], keep: ["type", "event", "at"], lane: "status" }],
  // The agent names its file in its binding: nothing is searched for.
  follow: async (pane) => (pane.store ? { path: pane.store } : null),
  read: (record) => {
    const at = parseInstant(record.at);
    const edge = STATUS_EDGES.find((known) => known === record.event);
    return at === null || edge === undefined ? null : { kind: edge, at };
  },
  ignores: (record) => record.type === "usage",
};

/** The edge a stub status report says, if it says one. */
function stubEdge(payload: unknown): (typeof STATUS_EDGES)[number] | null {
  const edge = isJsonRecord(payload) ? payload.event : undefined;
  return STATUS_EDGES.find((known) => known === edge) ?? null;
}

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
    output.command = process.execPath;
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
        status: {
          normalize: (payload, at) => {
            // A record of its file the host carried by this plugin's watch:
            // what it means is the dialect's, at the record's own time.
            const decoded = decodeStatusPayload(payload);
            if (decoded?.source === "record") return isStubRecord(decoded.record) ? stubTail.read(decoded.record) : null;
            const edge = stubEdge(payload);
            return edge === null ? null : { kind: edge, at };
          },
          attribute: (payload) => {
            if (decodeStatusPayload(payload)?.source === "record") return { event: null, actor: "main", status: true };
            const edge = stubEdge(payload);
            return edge === null ? null : { event: edge, actor: "main", status: true };
          },
          tail: stubTail,
        },
        hooks: {
          "spawn.plan"(input, output) {
            control.plans.push({ hook: "spawn", input, folderStood: existsSync(input.cwd) });
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
