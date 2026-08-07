/**
 * Settings — the global app settings document ([F6]), split by reason to change:
 *
 * - `types`    — the vocabulary: what a setting is and which values it admits;
 * - `codecs`   — how a stored value becomes a setting, and each default;
 * - `document` — what a document holds, and how a chosen value enters one;
 * - `persist`  — the hand-editable `settings.json` format, in both directions.
 *
 * The revision and compatibility floor live with every other document's in
 * `domain/migrations`, and are re-exported here for the surfaces that show them.
 */
export { SETTINGS_VERSION } from "../migrations";
export * from "./types";
export * from "./codecs";
export * from "./document";
export * from "./persist";
