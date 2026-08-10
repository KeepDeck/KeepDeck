import type { AgentType } from "../agents";
import { isRecord } from "../json";
import {
  DECK_LAYOUTS,
  DOCK_MODES,
  MINIMIZE_STYLES,
  NOTIFICATION_MODES,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  SUSPENDED_AGENT_PLACEMENTS,
  USAGE_DISPLAYS,
  type NotificationsMode,
  type Settings,
  type SettingsKey,
} from "./types";

/**
 * How a STORED value becomes a setting, and what each setting falls back to.
 * Changes when a key's tolerance or its default changes.
 *
 * `settings.json` is hand-editable, so every read here is tolerant: a value
 * this build cannot use degrades to that key's own default and says so, without
 * touching its siblings.
 */

/** Freeze `value` and the containers one level inside it. The default bags below
 * are SHARED into every document that chose neither, so a stray
 * `settings.plugins.enabled[id] = x` would poison the default for every module
 * that reads it as a fallback, process-wide and with no way back short of a
 * reload. One level down is exactly as deep as such a write reaches. */
function freezeBag<T extends object>(value: T): T {
  for (const inner of Object.values(value)) {
    if (typeof inner === "object" && inner !== null) Object.freeze(inner);
  }
  Object.freeze(value);
  return value;
}

const DEFAULT_PLUGINS = freezeBag<Settings["plugins"]>({
  enabled: {},
  values: {},
  consented: {},
});
const DEFAULT_NOTIFICATIONS = freezeBag<Settings["notifications"]>({
  enabled: true,
  mode: "system-and-app",
  mutedPlugins: [],
});

/** Where a discarded stored value is reported, so a load can say what it
 * dropped: a key (`"dockMode"`) or a path inside one (`"plugins.enabled.foo"`).
 * Readers call it; the persistence layer collects. */
export type Discard = (path: string) => void;

/**
 * How ONE setting is read from the stored document, and what it falls back to.
 *
 * `read` answers `undefined` only for a value this build cannot use AT ALL —
 * the wrong type, or outside the allow-list — and hydration then keeps the
 * default. A value it CAN use is returned even when it equals the default:
 * "usable" and "different from the default" are separate questions, and
 * conflating them is what erased a stored setting on the next save.
 *
 * It returns the accepted VALUE rather than merely vouching for the raw one,
 * because readers normalize: scrollback clamps, and the two bags rebuild
 * themselves entry by entry, reporting each entry they drop.
 */
export interface SettingCodec<T> {
  default: T;
  read(stored: unknown, discard: Discard): T | undefined;
}

/** Clamp a raw scrollback to a sane whole number of lines. */
export function clampScrollback(value: number): number {
  return Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, Math.round(value)));
}

/** A reader for a closed set of string literals: the stored value when the
 * allow-list admits it. */
function readOneOf<T extends string>(
  allowed: readonly T[],
): (stored: unknown) => T | undefined {
  return (stored) => (allowed.includes(stored as T) ? (stored as T) : undefined);
}

function readBoolean(stored: unknown): boolean | undefined {
  return typeof stored === "boolean" ? stored : undefined;
}

/** Any non-empty string id is kept: the id set is open (agents come from
 * plugins, hydration runs before their bootstrap). A preference whose plugin
 * is gone simply loses the picker vote — `defaultAgentType` snaps to the first
 * selectable agent. */
function readAgentId(stored: unknown): AgentType | undefined {
  return typeof stored === "string" && stored ? stored : undefined;
}

/** A stored scrollback is CLAMPED rather than rejected — a hand-edited 5 or
 * 1e9 is a real intent expressed out of range. Only a non-number degrades. */
function readScrollback(stored: unknown): number | undefined {
  return typeof stored === "number" && Number.isFinite(stored)
    ? clampScrollback(stored)
    : undefined;
}

/**
 * Tolerant read of the persisted plugin settings bag. A record is ALWAYS
 * accepted and rebuilt entry by entry — an empty result is a real choice ("no
 * plugin decisions"), not a failure, and calling it one is what erased the key
 * on the next save. `undefined` is reserved for a value that is not a record
 * at all.
 *
 * Each of `enabled` and `values` degrades independently, and within each, one
 * bad entry never drops its siblings — the file is hand-editable — and every
 * dropped entry is reported, so the load can say what it discarded.
 */
function readPlugins(
  value: unknown,
  discard: Discard,
): Settings["plugins"] | undefined {
  if (!isRecord(value)) return undefined;
  const enabled: Record<string, boolean> = {};
  if (isRecord(value.enabled)) {
    for (const [id, v] of Object.entries(value.enabled)) {
      if (typeof v === "boolean") enabled[id] = v;
      else discard(`plugins.enabled.${id}`);
    }
  } else if (value.enabled !== undefined) discard("plugins.enabled");
  const values: Record<string, Record<string, unknown>> = {};
  if (isRecord(value.values)) {
    for (const [id, v] of Object.entries(value.values)) {
      // The per-plugin values object is opaque past this point — kept
      // verbatim, like a workspace's plugin slot.
      if (isRecord(v)) values[id] = v;
      else discard(`plugins.values.${id}`);
    }
  } else if (value.values !== undefined) discard("plugins.values");
  const consented: Record<string, string> = {};
  if (isRecord(value.consented)) {
    for (const [id, v] of Object.entries(value.consented)) {
      if (typeof v === "string") consented[id] = v;
      else discard(`plugins.consented.${id}`);
    }
  } else if (value.consented !== undefined) discard("plugins.consented");
  return { enabled, values, consented };
}

/**
 * Tolerant read of the notifications bag, per-field like everything else: a
 * malformed field falls back to its own default, on its own, and says so. A
 * record is ALWAYS accepted (see [`readPlugins`] for why an all-default result
 * must not read as a failure); `undefined` means it was not a record.
 */
function readNotifications(
  value: unknown,
  discard: Discard,
): Settings["notifications"] | undefined {
  if (!isRecord(value)) return undefined;
  let enabled = DEFAULT_NOTIFICATIONS.enabled;
  if (typeof value.enabled === "boolean") enabled = value.enabled;
  else if (value.enabled !== undefined) discard("notifications.enabled");
  let mode = DEFAULT_NOTIFICATIONS.mode;
  if (NOTIFICATION_MODES.includes(value.mode as NotificationsMode)) {
    mode = value.mode as NotificationsMode;
  } else if (value.mode !== undefined) discard("notifications.mode");
  const mutedPlugins: string[] = [];
  if (Array.isArray(value.mutedPlugins)) {
    for (const id of value.mutedPlugins) {
      if (typeof id === "string") mutedPlugins.push(id);
      else discard("notifications.mutedPlugins");
    }
  } else if (value.mutedPlugins !== undefined) discard("notifications.mutedPlugins");
  return { enabled, mode, mutedPlugins };
}

/**
 * THE settings table: every key's default and its tolerant reader, together.
 *
 * The mapped type over `SettingsKey` is TOTAL, so adding a field to `Settings`
 * without a codec here is a compile error — which is the whole point. A key used
 * to live in four uncoupled places (the interface, the defaults object, a
 * hand-written `if` in hydration, and the known-key set). Omitting the `if` left
 * a setting that looked wired up but was never restored, and the writer then
 * ERASED it from disk on the next save — silently, with the file still looking
 * healthy. Nothing caught that, and it is the shape every "my settings reset
 * after the update" report takes.
 *
 * Key ORDER here is the order a saved document lists its keys.
 */
const SETTINGS_CODECS: { [K in SettingsKey]: SettingCodec<Settings[K]> } = {
  defaultAgent: { default: "claude", read: readAgentId },
  defaultYolo: { default: false, read: readBoolean },
  scrollback: { default: 10_000, read: readScrollback },
  deckLayout: { default: "grid", read: readOneOf(DECK_LAYOUTS) },
  minimizeStyle: { default: "tray", read: readOneOf(MINIMIZE_STYLES) },
  suspendedAgentPlacement: {
    default: "pane",
    read: readOneOf(SUSPENDED_AGENT_PLACEMENTS),
  },
  dockMode: { default: "docked", read: readOneOf(DOCK_MODES) },
  plugins: { default: DEFAULT_PLUGINS, read: readPlugins },
  notifications: { default: DEFAULT_NOTIFICATIONS, read: readNotifications },
  usageDisplay: { default: "used", read: readOneOf(USAGE_DISPLAYS) },
  remoteAgents: { default: false, read: readBoolean },
  parkAgentsOnLaunch: { default: false, read: readBoolean },
  mcpServer: { default: false, read: readBoolean },
  agentTeams: { default: false, read: readBoolean },
};

/** The table as entries, typed once so every consumer doesn't re-assert the
 * key type. Iteration order is the table's, which is the saved key order. */
export function settingsCodecs(): [SettingsKey, SettingCodec<unknown>][] {
  return Object.entries(SETTINGS_CODECS) as [
    SettingsKey,
    SettingCodec<unknown>,
  ][];
}

/** Whether `key` is a setting this build knows — the one place that question is
 * answered, so a patch carrying a stray key cannot enter a document. */
export function isSettingsKey(key: string): key is SettingsKey {
  return key in SETTINGS_CODECS;
}

/** Every setting at its default — DERIVED from the table, never hand-kept.
 * `Object.fromEntries` cannot carry the per-key types, so this is the one place
 * they are re-assembled into `Settings`; the table's totality is what makes the
 * assertion sound (a missing key fails to compile up there, so it cannot be
 * missing down here). */
export const DEFAULT_SETTINGS: Settings = Object.fromEntries(
  settingsCodecs().map(([key, codec]) => [key, codec.default]),
) as unknown as Settings;
