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
import { createVoiceController } from "./controller";
import { createModelDownloads } from "./downloads";
import { createModelsStore } from "./models";
import { installPttHotkeys } from "./hotkeys";
import { clearRuntime, runtime, setRuntime } from "./runtime";
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
    setRuntime({ ctx, controller, downloads, models });

    ctx.ui.registerDockTab({ id: "voice", label: "Voice", Component: VoiceTab });
    ctx.ui.registerOverlay({ id: "pill", Component: VoiceOverlay });
    // The whole section is the model manager — whisper detects the language
    // by itself, so there is nothing else to configure.
    ctx.settings.registerSection({
      label: "Voice",
      fields: [{ kind: "custom", key: "models", Component: ModelsSection }],
    });

    uninstallHotkeys = installPttHotkeys(controller);
  },

  async deactivate() {
    uninstallHotkeys?.();
    uninstallHotkeys = null;
    await runtimeController()?.cancel();
    clearRuntime();
  },
};

function runtimeController() {
  try {
    return runtime().controller;
  } catch {
    return null;
  }
}

export default plugin;
