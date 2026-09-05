import type { AgentType } from "../agents";

/**
 * The settings VOCABULARY: what a setting is, and which values each admits.
 * Changes when a setting is added or its shape changes — nothing here knows how
 * a value is read, stored, or decided.
 */

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
  /** Agent teams ([F6] → Experimental): panes can be grouped into a team,
   * each holding a role, and teammates can write to each other by role.
   *
   * Named for the FEATURE rather than for its transport. Messaging is how
   * teammates reach each other, but this flag also gates roles, addressing
   * and `team.assign` — calling it "mail" would understate what turning it
   * off takes away.
   *
   * A LIVE switch in both directions, and it gates the whole feature rather
   * than half of it: Off unregisters the commands (so they stop being MCP
   * tools) AND stops delivery, or a pane could receive what it has no way
   * to answer.
   *
   * Rides the deck's MCP socket, which has no switch of its own: sending is
   * an MCP call, so while the socket is down a pane can receive but not
   * answer. Default off; opt-in only while the feature is experimental. */
  agentTeams: boolean;
  /** Fleet artifacts ([F6] → Experimental): agents can publish presentation
   * pages (HTML/md) to a workspace-scoped store, served on localhost with
   * live refresh, shared as team review objects. A LIVE switch in both
   * directions: On claims the store root and starts the display server;
   * Off tears the server down (saying bye to open tabs) and releases the
   * claim — and unregisters the artifact_* commands, so they stop being
   * MCP tools the same turn.
   *
   * The TOOL half rides the deck's MCP socket (the commands are MCP
   * projections) — while it is down the display server and any published
   * artifacts keep serving, only new publishes go dark. Default off; opt-in
   * only while the feature is experimental. */
  artifacts: boolean;
  /** First publish of a NEW artifact opens it in the system browser (the
   * Claude Code artifacts UX; republish never re-opens — the open tab
   * refreshes live). Inert while `artifacts` is off. Default on. */
  artifactAutoOpen: boolean;
}

/** Every settings key. `keyof Settings` here, and the codec table is checked
 * against it, so the key set has exactly one home. */
export type SettingsKey = keyof Settings;

/** Scrollback bounds: below ~1k the terminal is useless with verbose agents;
 * above ~200k xterm's buffer memory (per pane, up to 16 panes) bites. */
export const SCROLLBACK_MIN = 1_000;
export const SCROLLBACK_MAX = 200_000;
