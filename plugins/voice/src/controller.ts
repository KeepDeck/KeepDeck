import type {
  CommandArgs,
  PluginContext,
  SpeechCapture,
} from "@keepdeck/plugin-api";
import { bestMatch } from "./fuzzy";
import { normalize, parseCommand, type Intent } from "./grammar";
import type { VoiceModelInfo } from "./modelCatalog";

/**
 * The voice controller — one push-to-talk state machine shared by the hotkey
 * handler, the mic button, the dock tab, and the overlay pill. Everything an
 * utterance becomes flows through here: capture → transcript → (command
 * grammar → deck command | dictation → pane.write) → a history entry per
 * step, so the tab reads like a chat log of what was heard and what was done.
 */
export type VoiceMode = "command" | "dictation";
export type VoicePhase = "idle" | "listening" | "transcribing";

export interface HistoryEntry {
  at: number;
  tone: "heard" | "done" | "error" | "info";
  text: string;
}

export interface VoiceSnapshot {
  phase: VoicePhase;
  mode: VoiceMode | null;
  /** Coarse mic RMS while listening, for the meter. */
  level: number;
  history: readonly HistoryEntry[];
}

/** The stored model choice. With no pick persisted, the controller prefers
 * whatever is actually installed before falling back to this id. */
export const MODEL_KEY = "model";
export const DEFAULT_MODEL = "whisper-small";

const HISTORY_CAP = 100;

interface WorkspaceRow {
  id: string;
  name: string;
  active: boolean;
  panes: { id: string; title: string }[];
}

export interface VoiceController {
  snapshot(): VoiceSnapshot;
  subscribe(cb: () => void): () => void;
  start(mode: VoiceMode): Promise<void>;
  stop(): Promise<void>;
  cancel(): Promise<void>;
  /** Empty the heard/done log. */
  clearHistory(): void;
}

export function createVoiceController(
  ctx: PluginContext,
  now: () => number = Date.now,
  currentModels: () => Promise<readonly VoiceModelInfo[]> = async () => [],
): VoiceController {
  let phase: VoicePhase = "idle";
  let mode: VoiceMode | null = null;
  let level = 0;
  let capture: SpeechCapture | null = null;
  let starting: Promise<SpeechCapture> | null = null;
  let history: HistoryEntry[] = [];
  const listeners = new Set<() => void>();
  // The snapshot is rebuilt only on change — useSyncExternalStore needs a
  // stable reference between notifications.
  let snap: VoiceSnapshot = { phase, mode, level, history };

  function notify(): void {
    snap = { phase, mode, level, history };
    for (const cb of [...listeners]) cb();
  }

  function push(tone: HistoryEntry["tone"], text: string): void {
    history = [...history, { at: now(), tone, text }].slice(-HISTORY_CAP);
  }

  async function workspaces(): Promise<WorkspaceRow[]> {
    const result = await ctx.commands.execute("workspace.list", {});
    if (!result.ok) throw new Error(result.error.message);
    return result.value as WorkspaceRow[];
  }

  /** Vocabulary bias for whisper: the names it should spell correctly plus
   * the command words of both shipped locales. */
  function buildPrompt(rows: WorkspaceRow[]): string {
    const names = rows.flatMap((w) => [w.name, ...w.panes.map((p) => p.title)]);
    return [
      ...new Set(names),
      "create agent in, switch to, focus, close",
      "создай агента в, перейди на, закрой",
    ].join(", ");
  }

  async function execute(id: string, args: CommandArgs): Promise<void> {
    const result = await ctx.commands.execute(id, args);
    if (result.ok) {
      push("done", describeDone(id, args));
    } else {
      push("error", result.error.message);
    }
  }

  /** Spoken references to "the newest one" — resolved positionally, not by
   * name ("close the latest agent", «закрой последнего агента»). */
  const LATEST_REF =
    /^(?:the )?(?:latest|last|newest)(?: open(?:ed)?)?(?: agent| one)?$|^послед(?:ний|него)(?: открыт(?:ый|ого))?(?: агент(?:а)?)?$/;

  /** A pane by spoken reference: positional ("latest") or fuzzy by title —
   * refusing, never guessing, on unknowns. */
  function resolvePane(
    active: WorkspaceRow,
    spoken: string,
  ): { id: string } | null {
    if (LATEST_REF.test(normalize(spoken))) {
      return active.panes[active.panes.length - 1] ?? null;
    }
    const title = bestMatch(active.panes.map((p) => p.title), spoken);
    return active.panes.find((p) => p.title === title) ?? null;
  }

  /** Turn a parsed intent into a deck command, resolving spoken names
   * against the live deck — refusing, never guessing, on unknowns. */
  async function runIntent(intent: Intent): Promise<void> {
    const rows = await workspaces();
    const wsNames = rows.map((w) => w.name);
    const resolveWs = (spoken: string): WorkspaceRow | null => {
      const name = bestMatch(wsNames, spoken);
      return rows.find((w) => w.name === name) ?? null;
    };
    const activeWs = () => rows.find((w) => w.active) ?? null;

    switch (intent.kind) {
      case "switch": {
        const ws = resolveWs(intent.workspace);
        if (!ws) return push("error", `no workspace sounds like "${intent.workspace}"`);
        return execute("workspace.switch", { workspace: ws.id });
      }
      case "spawn": {
        // No spoken workspace = the one on screen («запусти нового агента»).
        const ws = intent.workspace ? resolveWs(intent.workspace) : activeWs();
        if (!ws)
          return push(
            "error",
            intent.workspace
              ? `no workspace sounds like "${intent.workspace}"`
              : "no active workspace",
          );
        return execute("agent.spawn", {
          workspace: ws.id,
          ...(intent.task ? { task: intent.task } : {}),
        });
      }
      case "focus": {
        const active = activeWs();
        if (!active) return push("error", "no active workspace");
        const pane = resolvePane(active, intent.agent);
        if (!pane) return push("error", `no agent sounds like "${intent.agent}"`);
        return execute("agent.focus", { agent: pane.id });
      }
      case "close": {
        if (!intent.agent) return execute("agent.close", {});
        const active = activeWs();
        if (!active) return push("error", "no active workspace");
        const pane = resolvePane(active, intent.agent);
        if (!pane) return push("error", `no agent sounds like "${intent.agent}"`);
        return execute("agent.close", { agent: pane.id });
      }
    }
  }

  return {
    snapshot: () => snap,
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    async start(m) {
      if (phase !== "idle") return;
      phase = "listening";
      mode = m;
      level = 0;
      notify();
      const pending = ctx.services.speech.startCapture((rms) => {
        level = rms;
        notify();
      });
      starting = pending;
      try {
        const started = await pending;
        if (starting !== pending) {
          return;
        }
        if (phase !== "listening") {
          await started.cancel().catch(() => {});
        } else {
          capture = started;
        }
      } catch (e) {
        if (starting !== pending || phase !== "listening") return;
        phase = "idle";
        mode = null;
        push("error", e instanceof Error ? e.message : String(e));
        notify();
      } finally {
        if (starting === pending) starting = null;
      }
    },

    async stop() {
      if (phase !== "listening") return;
      const finished = mode;
      const activeCapture = capture;
      capture = null;
      if (!activeCapture) {
        phase = "idle";
        mode = null;
        level = 0;
        notify();
        return;
      }
      phase = "transcribing";
      notify();
      try {
        const [rows, values, models] = await Promise.all([
          workspaces().catch(() => [] as WorkspaceRow[]),
          ctx.settings.read(),
          currentModels(),
        ]);
        // The pick persists in the plugin's settings values (settings.json)
        // — the global KV is still a stub, and a choice that silently
        // evaporates on restart is worse than none.
        const persisted =
          typeof values[MODEL_KEY] === "string"
            ? (values[MODEL_KEY] as string)
            : null;
        const selected =
          models.find((model) => model.id === persisted && model.installed) ??
          models.find((model) => model.installed && !model.retired) ??
          models.find((model) => model.installed) ??
          null;
        if (!selected) throw new Error("no speech model is installed");

        // No language pin: whisper's auto-detect handles per-utterance
        // language switching better than any setting the user must remember.
        const transcript = await activeCapture.stop({
          engine: selected.engine,
          modelPath: selected.target.path,
          prompt: buildPrompt(rows),
        });

        if (transcript.silence || !transcript.text) {
          if (transcript.seconds > 0.3 && transcript.level < 0.0005) {
            // A real duration at a dead-zero level is not a quiet user — the
            // OS is delivering silence. Name the actual fix.
            push(
              "error",
              `the microphone delivered silence (${transcript.seconds.toFixed(1)}s at level 0) — check System Settings → Privacy & Security → Microphone; in dev the permission belongs to the terminal that launched the app`,
            );
          } else {
            push(
              "info",
              `didn't catch that (${transcript.seconds.toFixed(1)}s, level ${transcript.level.toFixed(3)})`,
            );
          }
        } else if (finished === "dictation") {
          push("heard", transcript.text);
          // Dictation only fills the input — the user reviews and sends it
          // themselves. No `submit`, or the transcript fires off to the agent
          // the instant push-to-talk is released.
          await execute("pane.write", { text: transcript.text });
        } else {
          push("heard", transcript.text);
          const parsed = parseCommand(transcript.text);
          if (!parsed) {
            push("info", "not a known command — try “create agent in <workspace>”");
          } else {
            await runIntent(parsed.intent);
          }
        }
      } catch (e) {
        await activeCapture.cancel().catch(() => {});
        push("error", e instanceof Error ? e.message : String(e));
      } finally {
        phase = "idle";
        mode = null;
        level = 0;
        notify();
      }
    },

    clearHistory() {
      history = [];
      notify();
    },

    async cancel() {
      const activeCapture = capture;
      const pending = starting;
      if (!activeCapture && !pending) return;
      capture = null;
      starting = null;
      phase = "idle";
      mode = null;
      level = 0;
      notify();
      if (activeCapture) {
        await activeCapture.cancel().catch(() => {});
      } else if (pending) {
        await pending.then((started) => started.cancel()).catch(() => {});
      }
    },
  };
}

function describeDone(id: string, args: CommandArgs): string {
  switch (id) {
    case "workspace.switch":
      return "switched workspace";
    case "agent.spawn":
      return args.task ? `agent spawned, task queued` : "agent spawned";
    case "agent.focus":
      return "agent focused";
    case "agent.close":
      return "close dialog opened";
    case "pane.write":
      return "typed into the input";
    default:
      return `${id} done`;
  }
}
