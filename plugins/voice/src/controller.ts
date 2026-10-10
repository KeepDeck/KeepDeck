import type {
  CommandArgs,
  PluginContext,
  SpeechCapture,
  SpeechLevel,
  SpeechTranscript,
} from "@keepdeck/plugin-api";
import { bestMatch } from "./fuzzy";
import { commandVocabulary, normalize, parseCommand, type Intent } from "./grammar";
import { createVoiceAlerts } from "./alerts";
import { activeModel, readModelPick } from "./modelChoice";
import { readMicPick, startOptionsFor, type MicPick } from "./microphone";
import {
  HOLD_PROBLEMS,
  holdProblems,
  problemOfError,
  START_PROBLEMS,
  type VoiceProblem,
} from "./problems";
import {
  didNotCatchLine,
  problemLine,
  problemWords,
  tooShortLine,
  type ProblemWords,
} from "./problemWords";
import type { VoiceModelInfo } from "./modelCatalog";

/**
 * The voice controller — one push-to-talk state machine shared by the hotkey
 * handler, the mic button, the dock tab, and the overlay pill. Everything an
 * utterance becomes flows through here: capture → transcript → (command
 * grammar → deck command | dictation → pane.write) → a history entry per
 * step, so the tab reads as a log of what was heard and what was done.
 *
 * The log runs NEWEST-FIRST: what was just said sits at the top, where it is
 * read and copied from, instead of scrolling away downwards. `at` still
 * carries the real timestamp, so chronology is never inferred from position.
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
  /** The device the current (or last) capture recorded from. */
  device: string | null;
  /** The latest meter reading of this capture, and when it arrived (ms). */
  reading: SpeechLevel | null;
  readingAt: number;
  /** What the last finished hold measured — the mic block's evidence. */
  lastHold: SpeechTranscript | null;
  history: readonly HistoryEntry[];
}


const HISTORY_CAP = 100;

interface WorkspaceRow {
  id: string;
  name: string;
  active: boolean;
  panes: { id: string; title: string }[];
}

interface DictationTarget {
  workspaceId: string;
  paneId: string;
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

const SPAWN_NEEDS_ROLE =
  'say what it is on its team — "create a lead in <workspace>" or "create a peer in <workspace>"';

export function createVoiceController(
  ctx: PluginContext,
  now: () => number = Date.now,
  currentModels: () => Promise<readonly VoiceModelInfo[]> = async () => [],
): VoiceController {
  let phase: VoicePhase = "idle";
  let mode: VoiceMode | null = null;
  let level = 0;
  let device: string | null = null;
  let reading: SpeechLevel | null = null;
  let readingAt = 0;
  let lastHold: SpeechTranscript | null = null;
  let capture: SpeechCapture | null = null;
  let starting: Promise<SpeechCapture> | null = null;
  // Starts whose capture someone has already undertaken to cancel. Whoever
  // marks a start first — the start itself or `cancel()` — owns its single
  // cancel; the other sees the mark and leaves it alone.
  const cancelledStarts = new WeakSet<Promise<SpeechCapture>>();
  function claimCancel(pending: Promise<SpeechCapture>): boolean {
    if (cancelledStarts.has(pending)) return false;
    cancelledStarts.add(pending);
    return true;
  }
  let transcribingCapture: SpeechCapture | null = null;
  let operationVersion = 0;
  let history: HistoryEntry[] = [];
  const listeners = new Set<() => void>();
  // The snapshot is rebuilt only on change — useSyncExternalStore needs a
  // stable reference between notifications.
  const build = (): VoiceSnapshot => ({
    phase,
    mode,
    level,
    device,
    reading,
    readingAt,
    lastHold,
    history,
  });
  let snap: VoiceSnapshot = build();
  const alerts = createVoiceAlerts(ctx.notify);
  // The microphone pick, kept current from the settings so a press opens the
  // device at once instead of reading settings first.
  let micPick: MicPick | null = null;
  void ctx.settings
    .read()
    .then((values) => (micPick = readMicPick(values)))
    .catch(() => {});
  ctx.settings.onChange((values) => (micPick = readMicPick(values)));

  function notify(): void {
    snap = build();
    for (const cb of [...listeners]) cb();
  }

  function push(tone: HistoryEntry["tone"], text: string): void {
    // Newest first (see the module note) — so the cap keeps the HEAD and the
    // oldest entries fall off the tail.
    history = [{ at: now(), tone, text }, ...history].slice(0, HISTORY_CAP);
  }

  /** One step's problems: announced (once) and written to the history. */
  function report(
    scope: readonly VoiceProblem[],
    problems: readonly VoiceProblem[],
    facts: Parameters<typeof problemWords>[1] = {},
  ): void {
    const present = new Map<VoiceProblem, ProblemWords>(
      problems.map((p) => [p, problemWords(p, facts)]),
    );
    alerts.update(scope, present);
    for (const words of present.values()) {
      push(words.severity === "error" ? "error" : "info", problemLine(words));
    }
  }

  /** What a finished hold amounts to, beyond its text. */
  function reportHold(t: SpeechTranscript): void {
    lastHold = t;
    report(HOLD_PROBLEMS, holdProblems(t), { device: t.device, seconds: t.seconds });
  }

  /** A failed speech call: the history line, and the alert when it is one
   * the user can act on. */
  function reportFailure(e: unknown): void {
    push("error", e instanceof Error ? e.message : String(e));
    const problem = problemOfError(e);
    if (!problem) return;
    const message = e instanceof Error ? e.message : undefined;
    alerts.update([problem], new Map([[problem, problemWords(problem, { message })]]));
  }

  async function workspaces(): Promise<WorkspaceRow[]> {
    const result = await ctx.commands.execute("workspace.list", {});
    if (!result.ok) throw new Error(result.error.message);
    return result.value as WorkspaceRow[];
  }

  /** Ask the application owner for an exact, already-resolved target. */
  async function dictationTarget(): Promise<DictationTarget | null> {
    const result = await ctx.commands.execute("pane.target", {});
    if (!result.ok || typeof result.value !== "object" || result.value === null) {
      return null;
    }
    const value = result.value as Record<string, unknown>;
    return typeof value.workspaceId === "string" && typeof value.paneId === "string"
      ? { workspaceId: value.workspaceId, paneId: value.paneId }
      : null;
  }

  /** Vocabulary bias for whisper: the names it should spell correctly plus
   * the command words of every grammar pack (read from the packs, never
   * copied). */
  function buildPrompt(rows: WorkspaceRow[]): string {
    const names = rows.flatMap((w) => [w.name, ...w.panes.map((p) => p.title)]);
    return [...new Set([...names, ...commandVocabulary()])].join(", ");
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
        // A role is never picked for the agent: a phrase that names none is
        // refused, and says how to name one.
        if (!intent.role) return push("error", SPAWN_NEEDS_ROLE);
        // No spoken workspace = the one on screen («запусти нового лида»).
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
          // The ROLE, not an address: which address it takes, and whether
          // the team it lands on can take it at all, are the host's.
          role: intent.role,
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
      operationVersion += 1;
      const operation = operationVersion;
      phase = "listening";
      mode = m;
      level = 0;
      reading = null;
      notify();
      const pending = ctx.services.speech.startCapture((rms, next) => {
        // A late level from an earlier capture must not paint this one.
        if (operation !== operationVersion || phase !== "listening") return;
        level = rms;
        reading = next ?? null;
        readingAt = now();
        notify();
      }, startOptionsFor(micPick));
      starting = pending;
      try {
        const started = await pending;
        // Superseded while opening (released, then pressed again), or
        // released before the mic opened: nobody else holds this capture, so
        // it is closed here or the mic leaks.
        if (starting !== pending || phase !== "listening") {
          if (claimCancel(pending)) await started.cancel().catch(() => {});
          return;
        }
        capture = started;
        device = started.device;
        // The pick is kept either way; the user hears once that it is gone.
        report(START_PROBLEMS, started.deviceMissing ? ["mic-missing"] : []);
        notify();
      } catch (e) {
        if (starting !== pending || phase !== "listening") return;
        phase = "idle";
        mode = null;
        reportFailure(e);
        notify();
      } finally {
        if (starting === pending) starting = null;
      }
    },

    async stop() {
      if (phase !== "listening") return;
      const operation = operationVersion;
      const finished = mode;
      const activeCapture = capture;
      capture = null;
      if (!activeCapture) {
        // Released before the mic opened: nothing was recorded — say so
        // rather than drop the press without a word.
        push("info", tooShortLine());
        phase = "idle";
        mode = null;
        level = 0;
        notify();
        return;
      }
      transcribingCapture = activeCapture;
      phase = "transcribing";
      notify();
      try {
        const [target, rows, values, models] = await Promise.all([
          finished === "dictation" ? dictationTarget() : Promise.resolve(null),
          workspaces().catch(() => [] as WorkspaceRow[]),
          ctx.settings.read(),
          currentModels(),
        ]);
        if (operation !== operationVersion) return;
        const selected = activeModel(models, readModelPick(values));
        if (!selected) {
          throw Object.assign(new Error("no speech model is installed"), { code: "model-missing" });
        }

        // No language pin: whisper's auto-detect handles per-utterance
        // language switching better than any setting the user must remember.
        const transcript = await activeCapture.stop({
          engine: selected.engine,
          modelPath: selected.target.path,
          prompt: buildPrompt(rows),
        });
        if (operation !== operationVersion) return;

        const spoken = !transcript.silence && transcript.text !== "";
        if (spoken) push("heard", transcript.text);
        reportHold(transcript);
        if (!spoken) {
          // A device-side reason was already reported; otherwise nobody spoke.
          if (holdProblems(transcript).length === 0) {
            push("info", didNotCatchLine(transcript.seconds));
          }
        } else if (finished === "dictation") {
          if (!target) {
            push("error", "no agent was selected when dictation stopped");
            return;
          }
          // Dictation fills the input as RAW keystrokes (mode: "type") so the
          // transcript lands inline and editable — a paste would collapse into
          // a non-editable [Pasted …] placeholder in most agent TUIs. The user
          // reviews and sends it themselves; no `submit`, or the transcript
          // fires off to the agent the instant push-to-talk is released.
          await execute("pane.write", {
            workspace: target.workspaceId,
            agent: target.paneId,
            text: transcript.text,
            mode: "type",
            focusInput: true,
          });
        } else {
          const parsed = parseCommand(transcript.text);
          if (!parsed) {
            push("info", "not a known command — try “create agent in <workspace>”");
          } else {
            await runIntent(parsed.intent);
          }
        }
      } catch (e) {
        await activeCapture.cancel().catch(() => {});
        if (operation !== operationVersion) return;
        reportFailure(e);
      } finally {
        if (transcribingCapture === activeCapture) transcribingCapture = null;
        if (operation === operationVersion) {
          phase = "idle";
          mode = null;
          level = 0;
          notify();
        }
      }
    },

    clearHistory() {
      history = [];
      notify();
    },

    async cancel() {
      const activeCapture = capture;
      const pending = starting;
      const activeTranscription = transcribingCapture;
      if (!activeCapture && !pending && !activeTranscription) return;
      operationVersion += 1;
      capture = null;
      starting = null;
      transcribingCapture = null;
      phase = "idle";
      mode = null;
      level = 0;
      notify();
      if (activeTranscription) {
        await activeTranscription.cancel().catch(() => {});
      } else if (activeCapture) {
        await activeCapture.cancel().catch(() => {});
      } else if (pending && claimCancel(pending)) {
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
