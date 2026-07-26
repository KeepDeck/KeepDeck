/**
 * The Voice built-in plugin — push-to-talk deck commands and dictation over
 * the plugin API's voice service, with all voice SEMANTICS living here: the
 * deterministic command grammar (en+ru locale packs), fuzzy name resolution,
 * the PTT hotkeys, the dock-tab history, and the listening pill. The core
 * knows none of it — it serves generic capture/STT and executes registry
 * commands this plugin invokes like any other client.
 */
import "./styles.css";
import type { KeepDeckPlugin, PluginContext } from "@keepdeck/plugin-api";
import { createVoiceController, MODEL_KEY } from "./controller";
import { HOTKEYS_KEY } from "./binding";
import { createModelDownloads } from "./downloads";
import { createModelsStore } from "./models";
import { createBindingsStore } from "./bindingsStore";
import { createRecordingLatch } from "./recordingLatch";
import { installPttHotkeys } from "./hotkeys";
import { clearRuntime, runtime, setRuntime, type VoiceRuntime } from "./runtime";
import { HotkeysSection } from "./components/HotkeysSection";
import { ModelsSection } from "./components/ModelsSection";
import { VoiceOverlay } from "./components/VoiceOverlay";
import { VoiceTab } from "./components/VoiceTab";

let uninstallHotkeys: (() => void) | null = null;

const plugin: KeepDeckPlugin = {
  async activate(ctx: PluginContext) {
    const models = createModelsStore(ctx);
    const controller = createVoiceController(ctx, Date.now, models.current);
    // A finished download refreshes the shared model list, so the tab's
    // "no model" prompt clears without reopening.
    const downloads = createModelDownloads(ctx, () => void models.refresh());
    // The live push-to-talk chords: read from settings, updated as the user
    // edits them, read by both the hotkey handler and the help copy. It is
    // LOADED further down, once the settings section exists.
    const bindings = createBindingsStore(ctx);
    // Silences push-to-talk while the settings recorder captures a new chord.
    const recordingLatch = createRecordingLatch();
    setRuntime({ ctx, controller, downloads, models, bindings, recordingLatch });

    ctx.ui.registerDockTab({ id: "voice", label: "Voice", Component: VoiceTab });
    ctx.ui.registerOverlay({ id: "pill", Component: VoiceOverlay });
    // Two custom fields: the push-to-talk hotkey editor and the model manager
    // (whisper auto-detects the language, so there is nothing else to set).
    // The keys come from the constants the two surfaces READ and WRITE, never
    // from literals: the host serves a plugin only the keys it declares here,
    // so a key that drifts from its constant is a value that never comes back.
    ctx.settings.registerSection({
      label: "Voice",
      fields: [
        { kind: "custom", key: HOTKEYS_KEY, Component: HotkeysSection },
        { kind: "custom", key: MODEL_KEY, Component: ModelsSection },
      ],
    });

    // Only now, with the fields declared: the host answers `settings.read` from
    // the section a plugin has registered, so a load before this one reads an
    // empty bag and every launch would push-to-talk on the shipped defaults
    // while the user's chords sat untouched in settings.json.
    bindings.load();

    uninstallHotkeys = installPttHotkeys(
      controller,
      () => bindings.get(),
      () => recordingLatch.active(),
    );
  },

  async deactivate() {
    uninstallHotkeys?.();
    uninstallHotkeys = null;
    const rt = tryRuntime();
    rt?.bindings.dispose();
    await rt?.controller.cancel();
    clearRuntime();
  },
};

/** The live runtime if the plugin is active, else null — a deactivate that
 * races activation (no runtime yet) reads null and no-ops. */
function tryRuntime(): VoiceRuntime | null {
  try {
    return runtime();
  } catch {
    return null;
  }
}

export default plugin;
