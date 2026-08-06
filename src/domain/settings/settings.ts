import type { AgentType } from "../agents";
import { collectExtras, isRecord } from "../json";

/**
 * Global app settings ([F6]) — schema, serialization and hydration.
 *
 * Like the deck ([F7]), the Rust side stores the JSON as an OPAQUE string
 * (`settings_load`/`settings_save` in src-tauri/src/state.rs) and every bit of
 * schema knowledge lives here. Unlike the deck, the document is a bag of
 * INDEPENDENT facts and is meant to be hand-editable (`settings.json` in
 * `~/.config/keepdeck`), so tolerance is per key, not all-or-nothing:
 *
 * - only unparsable JSON rejects the document (→ quarantine);
 * - a malformed value degrades just its own key to the default;
 * - unknown keys survive a save round-trip (hand edits and keys written by a
 *   newer build are preserved, not stripped);
 * - serialization is sparse — only keys that differ from the default are
 *   written, so a default improved in a later version reaches every user who
 *   never overrode it.
 *
 * Every key is declared exactly once, in [`SETTINGS_CODECS`]; the defaults and
 * the known-key set are DERIVED from it.
 */

// Revision + compatibility floor live with every other document's in
// domain/migrations; reading stays per-key tolerant — the floor is the
// only gate (a breach quarantines: rare, true breaking changes only).
export { SETTINGS_VERSION } from "../migrations";
import {
  SETTINGS_MIN_READER,
  SETTINGS_VERSION,
  settingsFloorBreach,
} from "../migrations";

/** How a workspace's agents are laid out:
 * - `grid` — the square grid (agents can be minimized out of it);
 * - `list` — a vertical list, one agent expanded to its terminal and the rest
 *   folded to bars. A display mode, NOT a way to minimize — every agent stays
 *   in place; the layout just shows one at a time. */
export type DeckLayout = "grid" | "list";

/** Every deck layout, in picker order; also the allow-list for a stored value. */
export const DECK_LAYOUTS: readonly DeckLayout[] = ["grid", "list"];

/** How a minimized agent is presented in the GRID layout:
 * - `tray`  — it docks as a chip in a strip along the bottom;
 * - `strip` — it folds to its own header bar, stacked below the grid;
 * - `none`  — minimizing is off (no control, no zone; every agent stays tiled).
 * For tray/strip the other agents stay on the grid and retile to fill the
 * space. The minimized SET is per-workspace runtime state
 * ([`WorkspaceView.minimized`]); this is only the presentation choice. */
export type MinimizeStyle = "tray" | "strip" | "none";

/** Every minimize style, in the order the settings picker lists them; also the
 * allow-list a stored value is validated against. */
export const MINIMIZE_STYLES: readonly MinimizeStyle[] = ["tray", "strip", "none"];

/** Where an agent the user suspended stays:
 * - `pane` — keep its tile in the deck and show the existing Resume card;
 * - `tray` — replace the tile with a stand-in in the bottom tray. Restoring
 *   that stand-in returns its stopped card; Resume remains a separate action.
 *
 * This is presentation only: the pane's durable `suspended` marker remains
 * the source of truth, so switching the preference never starts a process. */
export type SuspendedAgentPlacement = "pane" | "tray";

/** Every suspended-agent placement, in picker order and as the stored-value
 * allow-list. */
export const SUSPENDED_AGENT_PLACEMENTS: readonly SuspendedAgentPlacement[] = [
  "pane",
  "tray",
];

/** How the right-hand dock occupies the window:
 * - `docked`   — it takes a column of its own and the deck grid shrinks to fit;
 * - `floating` — it lies OVER the deck at the same edge, so the grid keeps its
 *   full width and never re-tiles when the dock opens or closes.
 * Only the dock's geometry: which tabs it holds and whether it is open at all
 * stay exactly as they were. */
export type DockMode = "docked" | "floating";

/** Every dock mode, in picker order; also the allow-list for a stored value. */
export const DOCK_MODES: readonly DockMode[] = ["docked", "floating"];

/** Which delivery channels notifications use:
 * - `system-and-app` — OS banners plus the in-app bell/center;
 * - `system` — OS banners only, no bell in the chrome;
 * - `app` — the bell only, the OS is never touched. */
export type NotificationsMode = "system-and-app" | "system" | "app";

/** Every notifications mode, in picker order; also the stored-value allow-list. */
export const NOTIFICATION_MODES: readonly NotificationsMode[] = [
  "system-and-app",
  "system",
  "app",
];

/** Which direction the usage chips' numbers run. Threshold COLOR always
 * follows % used regardless — the toggle changes the words, not the alarm. */
export type UsageDisplay = "used" | "left";

/** Every usage display, in cycle order; also the stored-value allow-list. */
export const USAGE_DISPLAYS: readonly UsageDisplay[] = ["used", "left"];

export interface Settings {
  /** Agent preselected for new workspaces and panes. Always a concrete
   * agent; if it isn't installed, the pickers snap to the first one that
   * is ([F1]). */
  defaultAgent: AgentType;
  /** YOLO mode preselected wherever an agent is created — each dialog's
   * toggle starts here and overrides per spawn. Applies at creation only:
   * flipping it never touches existing panes. */
  defaultYolo: boolean;
  /** Scrollback lines kept per terminal pane. */
  scrollback: number;
  /** How a workspace's agents are laid out (grid / list). */
  deckLayout: DeckLayout;
  /** How a minimized agent is presented in the grid layout (tray / strip). */
  minimizeStyle: MinimizeStyle;
  /** Whether a suspended agent keeps its pane or moves to the bottom tray. */
  suspendedAgentPlacement: SuspendedAgentPlacement;
  /** Whether the dock takes a column beside the deck or floats over it. */
  dockMode: DockMode;
  /** Per-plugin persisted settings, keyed by plugin id. The plugin system
   * itself is not a flag — it simply exists (user decision); `enabled` is
   * each plugin's own on/off switch, `values` is what a plugin's
   * host-rendered settings schema writes — opaque to this layer, like a
   * workspace's plugin slot ([`Workspace.plugins`]) — only the two bags'
   * SHAPE is ours. */
  plugins: {
    enabled: Record<string, boolean>;
    values: Record<string, Record<string, unknown>>;
    /** Per-EXTERNAL-plugin consent receipts: the capability fingerprint the
     * user last agreed to (set when enabling). An installed update whose
     * manifest capabilities no longer match falls back to disabled until
     * re-enabled — an escalation can't ride in on a stored enabled=true,
     * even across app restarts. */
    consented: Record<string, string>;
  };
  /** Notification delivery. `mutedPlugins` silences individual plugins'
   * notifications without disabling the plugin (only meaningful for plugins
   * holding the `notifications` capability). */
  notifications: {
    enabled: boolean;
    mode: NotificationsMode;
    mutedPlugins: string[];
  };
  /** How the usage chips present window percentages ("42%" vs "58% left"). */
  usageDisplay: UsageDisplay;
  /** Remote agents experiment ([F6] → Experimental): when off, the "+ Agent"
   *  dialog never offers "Where: Remote", even for agents that declare a
   *  native-server target — the whole remote-launch/connect surface stays
   *  hidden. Default off; opt-in only while the feature is experimental. */
  remoteAgents: boolean;
  /** Restore agents STOPPED instead of waking them ([F6] → General). A deck
   * of six agents otherwise launches six CLIs at once; with this on the panes
   * come back parked and each starts on its own card. Applies at launch only:
   * flipping it never touches panes that are already running. */
  parkAgentsOnLaunch: boolean;
  /** MCP server ([F6] → Experimental): expose the command registry to MCP
   * clients over the local socket. A live switch, not a launch flag: On
   * brings the socket up, Off tears it down and disconnects its clients.
   * Default off; opt-in only while the feature is experimental. */
  mcpServer: boolean;
}

/** Every settings key. Derived from [`SETTINGS_CODECS`], so the key set has
 * exactly one home. */
export type SettingsKey = keyof Settings;

/** Scrollback bounds: below ~1k the terminal is useless with verbose agents;
 * above ~200k xterm's buffer memory (per pane, up to 16 panes) bites. */
export const SCROLLBACK_MIN = 1_000;
export const SCROLLBACK_MAX = 200_000;

/** The default bags, standalone so both the codec table and the bags' own
 * readers can name them: a reader that degrades to "the default" must return
 * THIS object, and deriving the defaults from the table would otherwise make
 * the two mutually recursive. Their object IDENTITY is load-bearing — see
 * [`readNotifications`]. */
const DEFAULT_PLUGINS: Settings["plugins"] = {
  enabled: {},
  values: {},
  consented: {},
};
const DEFAULT_NOTIFICATIONS: Settings["notifications"] = {
  enabled: true,
  mode: "system-and-app",
  mutedPlugins: [],
};

/**
 * How ONE setting is read from the stored document, and what it falls back to.
 *
 * `read` answers `undefined` for anything this build cannot use — absent, the
 * wrong type, outside the allow-list — and hydration then keeps the default.
 * It returns the accepted VALUE rather than merely vouching for the raw one,
 * because readers normalize: scrollback clamps, and the two bags rebuild
 * themselves entry by entry.
 */
interface SettingCodec<T> {
  default: T;
  read(stored: unknown): T | undefined;
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
 * THE settings table: every key's default and its tolerant reader, together.
 *
 * The mapped type over `SettingsKey` is TOTAL, so adding a field to
 * [`Settings`] without a codec here is a compile error — which is the whole
 * point. A key used to live in four uncoupled places (the interface, the
 * defaults object, a hand-written `if` in hydration, and the known-key set).
 * Omitting the `if` left a setting that looked wired up but was never
 * restored, and the sparse writer then ERASED it from disk on the next save —
 * silently, with the file still looking healthy. Nothing caught that, and it
 * is the shape every "my settings reset after the update" report takes.
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
};

/** Every setting at its default — DERIVED from the table, never hand-kept.
 * `Object.fromEntries` cannot carry the per-key types, so this is the one
 * place they are re-assembled into `Settings`; the table's totality is what
 * makes the assertion sound (a missing key fails to compile up there, so it
 * cannot be missing down here). */
export const DEFAULT_SETTINGS: Settings = Object.fromEntries(
  settingsCodecs().map(([key, codec]) => [key, codec.default]),
) as unknown as Settings;

/** The table as entries, typed once so hydration and the derivations above
 * don't each re-assert the key type. */
function settingsCodecs(): [SettingsKey, SettingCodec<unknown>][] {
  return Object.entries(SETTINGS_CODECS) as [
    SettingsKey,
    SettingCodec<unknown>,
  ][];
}

/** A settings value plus the unknown top-level keys of the stored document,
 * carried so a save can write them back verbatim. */
export interface SettingsDocument {
  settings: Settings;
  extras: Record<string, unknown>;
  /**
   * Keys this document must WRITE even when their value equals today's
   * default: the ones the stored file carried a usable value for, plus the
   * ones set since through [`withSettings`].
   *
   * Without it, "never chosen" and "chosen, and it happens to equal today's
   * default" are the same thing on disk, and sparse serialization erases the
   * second. Two consequences, both real: a stored `false` vanished from the
   * file, and any release that CHANGED a default silently flipped the setting
   * for everyone who had deliberately picked the old value (this already
   * happened once — `defaultAgent` went from `null` to `"claude"`).
   *
   * A key the file mentioned but whose value had to be discarded is
   * deliberately NOT here: re-writing garbage as a synthesized default would
   * grow the file on every load without recording any decision.
   */
  explicit: ReadonlySet<SettingsKey>;
}

/** The document a first run (or a quarantined file) starts from. Nothing is
 * explicit yet — no file said anything and the user has chosen nothing, so a
 * save writes only the version markers. */
export function defaultSettingsDocument(): SettingsDocument {
  return { settings: { ...DEFAULT_SETTINGS }, extras: {}, explicit: new Set() };
}

/**
 * The document with `patch` applied — the ONE way a chosen value enters a
 * document. Every patched key becomes explicit, because the user picking the
 * value that happens to be today's default is still a decision, and the file
 * is where that decision has to survive a change of default.
 */
export function withSettings(
  doc: SettingsDocument,
  patch: Partial<Settings>,
): SettingsDocument {
  const explicit = new Set(doc.explicit);
  for (const key of Object.keys(patch) as SettingsKey[]) explicit.add(key);
  return {
    settings: { ...doc.settings, ...patch },
    extras: doc.extras,
    explicit,
  };
}

/**
 * Fold a stand-in document — one the app only has because the settings file
 * could not be read — onto the `stored` document that has since turned up.
 *
 * The stored file WINS for everything the stand-in did not explicitly choose,
 * so a transient unreadable load can no longer end with the user's whole file
 * replaced by defaults: the only values that survive from the stand-in are the
 * ones somebody actually set while it was live. Extras come from the file too —
 * a stand-in has none, and dropping a newer build's keys would be its own
 * silent loss.
 */
export function reconcileProvisional(
  stored: SettingsDocument,
  provisional: SettingsDocument,
): SettingsDocument {
  // Correlating `key` with `Settings[key]` across a loop is beyond what the
  // checker can track; the keys come from `explicit`, so each value is that
  // key's own type by construction.
  const patch = {} as Record<SettingsKey, unknown>;
  for (const key of provisional.explicit) patch[key] = provisional.settings[key];
  return withSettings(stored, patch as Partial<Settings>);
}

/**
 * What a load learned about the stored TEXT, beyond the values it yielded: the
 * revision it was written at, and the keys it carried whose values this build
 * had to discard.
 *
 * Read separately from [`hydrateSettings`] rather than returned with the
 * document, because it describes the FILE, and a document stops corresponding
 * to its file the moment `withSettings` touches it — a field carried along
 * would quietly become a lie. The cost is re-parsing one small document once
 * per launch, and it buys a load that says what it dropped: a silent per-key
 * degrade is exactly what makes "my settings reset" impossible to diagnose.
 */
export interface SettingsProvenance {
  /** The document's own revision, or `null` when it declares none. */
  version: number | null;
  /** Keys present in the file whose value fell back to its default. */
  degraded: SettingsKey[];
}

export function settingsProvenance(json: string): SettingsProvenance {
  const blank: SettingsProvenance = { version: null, degraded: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return blank;
  }
  if (!isRecord(raw)) return blank;
  const degraded: SettingsKey[] = [];
  for (const [key, codec] of settingsCodecs()) {
    if (key in raw && codec.read(raw[key]) === undefined) degraded.push(key);
  }
  return {
    version: typeof raw.version === "number" ? raw.version : null,
    degraded,
  };
}

/** `version` plus every key `Settings` owns, plus retired keys we still
 * consume (a retired key riding extras would be rewritten forever). */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  "version",
  "minVersion",
  "experimentRunPresets",
  ...Object.keys(SETTINGS_CODECS),
]);

/** Clamp a raw scrollback to a sane whole number of lines. */
export function clampScrollback(value: number): number {
  return Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, Math.round(value)));
}

/** The notifications bag with `pluginId` (un)muted — deduplicating, so a
 * repeated mute can't stack the id, and order-stable for everyone else. */
export function withPluginMuted(
  prefs: Settings["notifications"],
  pluginId: string,
  muted: boolean,
): Settings["notifications"] {
  const rest = prefs.mutedPlugins.filter((id) => id !== pluginId);
  return { ...prefs, mutedPlugins: muted ? [...rest, pluginId] : rest };
}

/**
 * Tolerant read of the persisted plugin settings bag: `undefined` when there's
 * nothing to keep — an absent/malformed field, or one whose sub-parts all
 * degrade to empty — so hydration leaves `settings.plugins` pointing at the
 * shared default object and a later save stays sparse (mirrors how a malformed
 * value elsewhere degrades to its exact default, object identity included,
 * instead of a fresh-but-equal object that would defeat the `!==`-against-
 * default check in `serializeSettings`).
 *
 * Each of `enabled` and `values` degrades independently, and within each, one
 * bad entry never drops its siblings — the file is hand-editable.
 */
function readPlugins(value: unknown): Settings["plugins"] | undefined {
  if (!isRecord(value)) return undefined;
  const enabled: Record<string, boolean> = {};
  if (isRecord(value.enabled)) {
    for (const [id, v] of Object.entries(value.enabled)) {
      if (typeof v === "boolean") enabled[id] = v;
    }
  }
  const values: Record<string, Record<string, unknown>> = {};
  if (isRecord(value.values)) {
    for (const [id, v] of Object.entries(value.values)) {
      // The per-plugin values object is opaque past this point — kept
      // verbatim, like a workspace's plugin slot.
      if (isRecord(v)) values[id] = v;
    }
  }
  const consented: Record<string, string> = {};
  if (isRecord(value.consented)) {
    for (const [id, v] of Object.entries(value.consented)) {
      if (typeof v === "string") consented[id] = v;
    }
  }
  if (
    Object.keys(enabled).length === 0 &&
    Object.keys(values).length === 0 &&
    Object.keys(consented).length === 0
  ) {
    return undefined;
  }
  return { enabled, values, consented };
}

/**
 * Tolerant read of the notifications bag, per-field like everything else:
 * a malformed field falls back to its own default without dragging the
 * siblings down. `undefined` when the result IS the default — hydration then
 * keeps `settings.notifications` pointing at the shared default object so the
 * sparse-write `!==`-against-default check stays correct (the same
 * object-identity contract as [`readPlugins`]).
 */
function readNotifications(
  value: unknown,
): Settings["notifications"] | undefined {
  if (!isRecord(value)) return undefined;
  const defaults = DEFAULT_NOTIFICATIONS;
  const enabled =
    typeof value.enabled === "boolean" ? value.enabled : defaults.enabled;
  const mode = NOTIFICATION_MODES.includes(value.mode as NotificationsMode)
    ? (value.mode as NotificationsMode)
    : defaults.mode;
  // A fresh [] rather than defaults.mutedPlugins: this bag is only returned
  // when some field is non-default, and sharing the module-level default
  // array into a live settings object would let any future in-place mutation
  // poison the process-wide default (readPlugins builds fresh maps for the
  // same reason).
  const mutedPlugins = Array.isArray(value.mutedPlugins)
    ? value.mutedPlugins.filter((id): id is string => typeof id === "string")
    : [];
  if (
    enabled === defaults.enabled &&
    mode === defaults.mode &&
    mutedPlugins.length === 0
  ) {
    return undefined;
  }
  return { enabled, mode, mutedPlugins };
}

/**
 * Restore settings from stored JSON. Returns `null` only for a document that
 * isn't a JSON object at all — the caller quarantines it and starts from
 * defaults. Anything else yields usable settings: each recognized key is
 * validated on its own and falls back to its default individually. The
 * `version` field is written for future migrations but deliberately not
 * gated on here — with per-key tolerance, reading a newer document extracts
 * whatever this build understands and preserves the rest as extras.
 */
export function hydrateSettings(json: string): SettingsDocument | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const doc = raw as Record<string, unknown>;
  // Above our compatibility floor → quarantine (per-key tolerance covers
  // additive futures; a raised floor means a key CHANGED MEANING, and
  // half-understanding it would be worse than defaults + kept evidence).
  if (settingsFloorBreach(doc) !== null) return null;

  const settings = { ...DEFAULT_SETTINGS } as Record<SettingsKey, unknown>;
  const explicit = new Set<SettingsKey>();
  for (const [key, codec] of settingsCodecs()) {
    // `in` rather than an undefined check: JSON cannot carry `undefined`, so
    // presence is exactly "the file said something about this key" — which is
    // what separates an absent key from one whose value we had to discard.
    if (!(key in doc)) continue;
    const value = codec.read(doc[key]);
    if (value === undefined) continue;
    settings[key] = value;
    // The file carried a usable value, so it stays in the file — even if it
    // equals today's default. See [`SettingsDocument.explicit`].
    explicit.add(key);
  }
  const restored = settings as Settings;
  // Settings v5 graduation: the retired run-presets experiment flag maps onto
  // the Run plugin's enabled toggle so a user's prior state carries across the
  // transition — someone who had the experiment ON keeps Run on (plugins now
  // default OFF, so without this they'd lose it), and an explicit OFF stays
  // off. Only applied while the plugins bag has no say of its own, and the key
  // is consumed (KNOWN_KEYS), never re-written — rewriting it forever would
  // re-apply the mapping after the user later toggles the plugin.
  if (
    typeof doc.experimentRunPresets === "boolean" &&
    restored.plugins.enabled["keepdeck.run"] === undefined
  ) {
    restored.plugins = {
      ...restored.plugins,
      enabled: {
        ...restored.plugins.enabled,
        "keepdeck.run": doc.experimentRunPresets,
      },
    };
  }

  return {
    settings: restored,
    extras: collectExtras(doc, KNOWN_KEYS),
    explicit,
  };
}

/** Serialize for storage: version, preserved extras, then every setting that
 * either differs from its default or was explicitly chosen (see
 * [`SettingsDocument.explicit`] — a value equal to today's default still has
 * to survive tomorrow's change of default). */
export function serializeSettings(doc: SettingsDocument): string {
  const out: Record<string, unknown> = {
    version: SETTINGS_VERSION,
    minVersion: SETTINGS_MIN_READER,
    ...doc.extras,
  };
  for (const [key, codec] of settingsCodecs()) {
    if (doc.explicit.has(key) || doc.settings[key] !== codec.default) {
      out[key] = doc.settings[key];
    }
  }
  return JSON.stringify(out);
}
