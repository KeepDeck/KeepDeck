import type { VoiceModelInfo } from "./modelCatalog";

/**
 * Which model recognises speech — ONE rule, read by the controller (to
 * transcribe) and by the settings cards (to mark "Active"), so the card
 * marked active is always the model actually used. Before this, the cards
 * fell back to a fixed default id while the controller fell back to
 * whatever was installed, and the two could disagree.
 */

/** Where the pick lives in the plugin's settings values (settings.json). */
export const MODEL_KEY = "model";

/** The stored pick, or null when none was made. */
export function readModelPick(values: Record<string, unknown>): string | null {
  const value = values[MODEL_KEY];
  return typeof value === "string" && value !== "" ? value : null;
}

/** The model that will be used: the pick when it is installed, otherwise
 * the first installed current model, otherwise any installed one (a retired
 * install keeps working); null when nothing is installed. */
export function activeModel(
  models: readonly VoiceModelInfo[],
  pick: string | null,
): VoiceModelInfo | null {
  return (
    models.find((m) => m.id === pick && m.installed) ??
    models.find((m) => m.installed && !m.retired) ??
    models.find((m) => m.installed) ??
    null
  );
}
