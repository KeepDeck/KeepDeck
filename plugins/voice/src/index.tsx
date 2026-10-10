/**
 * The Voice built-in plugin — push-to-talk deck commands and dictation over
 * the plugin API's voice service, with all voice SEMANTICS living here: the
 * deterministic command grammar (en+ru locale packs), fuzzy name resolution,
 * the PTT hotkeys, the dock-tab history, and the listening pill. The core
 * knows none of it — it serves generic capture/STT and executes registry
 * commands this plugin invokes like any other client.
 *
 * Activation only starts the feature; `startVoiceFeature` owns the rest.
 */
import "./styles.css";
import type { KeepDeckPlugin, PluginContext } from "@keepdeck/plugin-api";
import { startVoiceFeature, type VoiceFeature } from "./feature";

let feature: VoiceFeature | null = null;

const plugin: KeepDeckPlugin = {
  async activate(ctx: PluginContext) {
    feature = startVoiceFeature(ctx);
  },

  async deactivate() {
    const running = feature;
    feature = null;
    await running?.dispose();
  },
};

export default plugin;
