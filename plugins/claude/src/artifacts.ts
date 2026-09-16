import type { SettingsField } from "@keepdeck/plugin-api";

/** The key the switch stores under — declared here and read here, one name. */
const KEY = "artifacts";

/**
 * claude's OWN artifacts — the pages it publishes to claude.ai and shares by
 * link. A different thing from KeepDeck's Fleet artifacts: these are the
 * CLI's, published whether or not it ever hears of the deck. The switch
 * lives on this plugin's page rather than the deck's because the variable
 * that carries it is one CLI's dialect and nothing else speaks it.
 *
 * ON by default, and ON means the deck has NO opinion: claude's own settings
 * decide, exactly as they would for a pane the deck did not start.
 */
export const ARTIFACTS_FIELD: Extract<SettingsField, { kind: "boolean" }> = {
  kind: "boolean",
  key: KEY,
  // Names the DESTINATION: "artifacts" alone reads as the deck's own.
  label: "Publish artifacts to claude.ai",
  // The two things a person cannot see from the switch: which artifacts
  // these are (not the deck's), and that a flip does not reach into a pane
  // that is already running.
  description:
    "Claude Code's own artifacts — pages it uploads to claude.ai and shares " +
    "by link, separate from the deck's Fleet artifacts. Applies to agents " +
    "started after the change; a running one keeps what it started with.",
  default: true,
};

/**
 * The variable claude reads to switch them off. It disables for exactly
 * `1`, `true`, `yes` or `on` (case-insensitive; read off claude 2.1.273):
 * `""`, `0` and `false` leave artifacts ON. So no value says "on" any louder
 * than absence does — and none would rescue an `enableArtifact: false` in the
 * user's own settings either, which is why ON emits nothing rather than
 * pretending to override anything.
 */
export const DISABLE_ARTIFACTS_VAR = "CLAUDE_CODE_DISABLE_ARTIFACT";

/**
 * The pane environment this plugin's resolved settings ask for: the disable
 * variable when the switch is off, nothing otherwise. Takes the values the
 * host resolved through the section (defaults applied), so anything but an
 * explicit `false` is on.
 *
 * Rides `env`, not `envDefaults`: this is a choice the user made in the deck,
 * and it has to beat the same variable arriving from a shell profile — which
 * `envDefaults` would let win.
 */
export const artifactsEnv = (
  values: Record<string, unknown>,
): [string, string][] =>
  values[KEY] === false ? [[DISABLE_ARTIFACTS_VAR, "1"]] : [];
