import type { PluginContext } from "@keepdeck/plugin-api";
import { HOTKEYS_KEY } from "./binding";
import { createBindingsStore } from "./bindingsStore";
import { HotkeysSection } from "./components/HotkeysSection";
import { ModelsSection } from "./components/ModelsSection";
import { VoiceOverlay } from "./components/VoiceOverlay";
import { VoiceTab } from "./components/VoiceTab";
import { createVoiceController } from "./controller";
import { createModelDownloads } from "./downloads";
import { installPttHotkeys } from "./hotkeys";
import { MIC_KEY } from "./microphone";
import { MODEL_KEY } from "./modelChoice";
import { createModelsStore } from "./models";
import { createRecordingLatch } from "./recordingLatch";
import { clearRuntime, setRuntime } from "./runtime";

/**
 * The Voice feature's one owner: builds every part, wires them, registers
 * them with the host, and takes them down again — the plugin's
 * activate/deactivate only start and stop it.
 */
export interface VoiceFeature {
  /** Release everything: hotkeys off, subscriptions closed, a capture in
   * flight cancelled, the runtime cleared. Safe to call more than once. */
  dispose(): Promise<void>;
}

export function startVoiceFeature(ctx: PluginContext): VoiceFeature {
  const models = createModelsStore(ctx);
  const controller = createVoiceController(ctx, Date.now, models.current);
  // A finished download refreshes the shared model list, so the tab's
  // "no model" prompt clears without reopening.
  const downloads = createModelDownloads(ctx, () => void models.refresh());
  // Silences push-to-talk while the settings recorder captures a new chord.
  const recordingLatch = createRecordingLatch();

  // Declared FIRST, because the host serves a plugin only the values its own
  // section declares — anything reading settings above this line gets an
  // empty bag. Two custom fields — the push-to-talk hotkey editor and the
  // model manager — and the microphone pick, chosen in the Voice tab, kept
  // as a `stored` value. The keys come from the constants those surfaces
  // READ and WRITE, never from literals: a key that drifts from its
  // constant is a value that never comes back.
  ctx.settings.registerSection({
    label: "Voice",
    fields: [
      { kind: "custom", key: HOTKEYS_KEY, Component: HotkeysSection },
      { kind: "custom", key: MODEL_KEY, Component: ModelsSection },
    ],
    stored: [MIC_KEY],
  });
  // The live push-to-talk chords, read at construction now that the fields
  // exist. Registering the section above hands the host a Component that
  // calls `runtime()` when RENDERED — safe before setRuntime because nothing
  // between these two statements awaits, so no render can interleave.
  const bindings = createBindingsStore(ctx);
  setRuntime({ ctx, controller, downloads, models, bindings, recordingLatch });

  ctx.ui.registerDockTab({ id: "voice", label: "Voice", Component: VoiceTab });
  ctx.ui.registerOverlay({ id: "pill", Component: VoiceOverlay });

  const uninstallHotkeys = installPttHotkeys(
    controller,
    () => bindings.get(),
    () => recordingLatch.active(),
  );

  let disposed = false;
  return {
    async dispose() {
      if (disposed) return;
      disposed = true;
      uninstallHotkeys();
      bindings.dispose();
      await controller.cancel();
      clearRuntime();
    },
  };
}
