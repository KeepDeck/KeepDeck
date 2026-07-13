import type { CommandArgs, PluginContext } from "@keepdeck/plugin-api";
import { bestMatch } from "./fuzzy";
import { normalize, parseCommand, type Intent } from "./grammar";

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

/** The stored model choice; the registry's smallest model as the fallback
 * keeps first-run friction at one download. */
export const MODEL_KEY = "model";
export const DEFAULT_MODEL = "whisper-base-q5_1";
/** Settings key for the pinned transcription language. */
export const LANGUAGE_KEY = "language";

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
): VoiceController {
  let phase: VoicePhase = "idle";
  let mode: VoiceMode | null = null;
  let level = 0;
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
      try {
        await ctx.services.voice.startCapture((rms) => {
          level = rms;
          notify();
        });
      } catch (e) {
        phase = "idle";
        mode = null;
        push("error", e instanceof Error ? e.message : String(e));
        notify();
      }
    },

    async stop() {
      if (phase !== "listening") return;
      const finished = mode;
      phase = "transcribing";
      notify();
      try {
        const rows = await workspaces().catch(() => [] as WorkspaceRow[]);
        const values = await ctx.settings.read();
        const language =
          typeof values[LANGUAGE_KEY] === "string" && values[LANGUAGE_KEY] !== "auto"
            ? (values[LANGUAGE_KEY] as string)
            : undefined;
        const model =
          (await ctx.storage.global.get<string>(MODEL_KEY)) ?? DEFAULT_MODEL;

        const transcript = await ctx.services.voice.stopCapture({
          model,
          ...(language ? { language } : {}),
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
          await execute("pane.write", { text: transcript.text, submit: true });
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
      if (phase !== "listening") return;
      phase = "idle";
      mode = null;
      level = 0;
      notify();
      await ctx.services.voice.cancelCapture().catch(() => {});
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
      return "sent to the focused agent";
    default:
      return `${id} done`;
  }
}
