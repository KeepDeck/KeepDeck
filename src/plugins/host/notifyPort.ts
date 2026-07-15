import {
  stripUnsafeText,
  type PluginLogger,
  type PluginManifest,
  type PluginNotify,
  type PluginNotifyInput,
} from "@keepdeck/plugin-api";
import type { GateMode } from "../capabilities/gate";

/** String caps — a notification is a glance, not a document. Anything longer
 * is cut, not refused: the message still reaches the user. The manifest caps
 * the plugin NAME (prefixed onto the title downstream), so the composed title
 * stays bounded too. */
const TITLE_MAX = 120;
const BODY_MAX = 500;
const TAG_MAX = 64;

/** Token bucket: an initial burst, then a slow steady refill. Chosen for the
 * legitimate shapes ("3 checks finished together", then quiet) while a loop
 * that notifies per tick dries up after the burst. */
const BUCKET_BURST = 3;
const REFILL_MS = 10_000; // one token per 10s

const SEVERITIES = ["info", "warning", "error"] as const;

/** What the port hands downstream — the sanitized input plus the host-owned
 * origin fields. The port depends on this narrow sink, not on the app's
 * notification center, so it tests in isolation. */
export interface PluginNotificationDelivery {
  pluginId: string;
  title: string;
  body?: string;
  severity: (typeof SEVERITIES)[number];
  wsId?: string;
  dockTab?: string;
  /** Already namespaced `plugin:<id>:<tag>`. */
  tag?: string;
}

export type PluginNotificationSink = (
  delivery: PluginNotificationDelivery,
) => void;

/** A delivery as the notification center's `notify()` input — the host names
 * the sender in the title, so an entry cannot pose as a system event or as
 * another plugin. Pure; `pluginName` is manifest-validated (bounded, clean). */
export function composePluginNotification(
  pluginName: string,
  d: PluginNotificationDelivery,
): {
  title: string;
  body?: string;
  severity: (typeof SEVERITIES)[number];
  source: { type: "plugin"; pluginId: string; wsId?: string; dockTab?: string };
  tag?: string;
} {
  return {
    title: `${pluginName} · ${d.title}`,
    severity: d.severity,
    source: {
      type: "plugin",
      pluginId: d.pluginId,
      ...(d.wsId !== undefined ? { wsId: d.wsId } : {}),
      ...(d.dockTab !== undefined ? { dockTab: d.dockTab } : {}),
    },
    ...(d.body !== undefined ? { body: d.body } : {}),
    ...(d.tag !== undefined ? { tag: d.tag } : {}),
  };
}

/**
 * Build one plugin's `ctx.notify` — the host side of the `notifications`
 * capability. Everything a plugin must not control happens here:
 *
 * - the mute check FIRST, silently: a muted plugin spends no tokens and
 *   writes no log lines — mute is a containment tool, not just a display
 *   preference;
 * - the capability check, in the gate's two tiers (built-in warns, external
 *   throws) — same policy as every service call;
 * - the per-plugin token bucket, spent on EVERY attempt (junk input included:
 *   an invalid-call loop drains its own budget, not the host);
 * - sanitization at a single choke point: only own, length-capped plain
 *   strings survive, with control/bidi/line-separator codepoints stripped
 *   (they could visually detach the host's attribution prefix from a banner);
 * - namespacing: the delivered `tag` is `plugin:<id>:<tag>`, so one plugin
 *   can never replace another's entry, and `pluginId` comes from the
 *   manifest, never the input;
 * - throttled complaint logging: drops are reported at most once per refill
 *   window (with a suppressed-count), so a hostile loop cannot turn the
 *   shared log file into a disk-filler.
 */
export function createPluginNotifyPort(
  manifest: PluginManifest,
  opts: {
    mode: GateMode;
    log: PluginLogger;
    deliver: PluginNotificationSink;
    /** Whether the user muted this plugin's notifications. Read per call —
     * settings change live. */
    muted?: () => boolean;
  },
): PluginNotify {
  const { mode, log, deliver, muted } = opts;
  const declared = manifest.capabilities.some(
    (cap) => cap.kind === "notifications",
  );

  let tokens = BUCKET_BURST;
  let lastRefillAt = 0;

  function takeToken(now: number): boolean {
    if (lastRefillAt === 0) lastRefillAt = now;
    const refilled = Math.floor((now - lastRefillAt) / REFILL_MS);
    if (refilled > 0) {
      tokens = Math.min(BUCKET_BURST, tokens + refilled);
      lastRefillAt += refilled * REFILL_MS;
    }
    if (tokens <= 0) return false;
    tokens -= 1;
    return true;
  }

  // One complaint per refill window, whatever the reason — the counter keeps
  // the dropped volume honest without writing a line per drop.
  let lastWarnAt = Number.NEGATIVE_INFINITY;
  let suppressed = 0;

  function warnThrottled(now: number, message: string): void {
    if (now - lastWarnAt < REFILL_MS) {
      suppressed += 1;
      return;
    }
    log.warn(
      suppressed > 0 ? `${message} (+${suppressed} more suppressed)` : message,
    );
    lastWarnAt = now;
    suppressed = 0;
  }

  return (input: PluginNotifyInput) => {
    if (muted?.()) return;

    const now = Date.now();
    if (!declared) {
      const message =
        'notify requires a "notifications" capability, which the manifest does not declare';
      if (mode === "enforce") throw new Error(message);
      warnThrottled(now, message);
    }
    if (!takeToken(now)) {
      warnThrottled(now, "notify: rate limit — dropped");
      return;
    }

    // External input is `unknown` in practice (it crossed the realm bridge):
    // trust nothing, keep only own plain-string fields, strip restructuring
    // codepoints, cap lengths.
    const raw: Record<string, unknown> =
      typeof input === "object" && input !== null
        ? (input as unknown as Record<string, unknown>)
        : {};
    const title =
      typeof raw.title === "string" ? stripUnsafeText(raw.title) : "";
    if (title === "") {
      warnThrottled(now, "notify: dropped — a non-empty string title is required");
      return;
    }
    const body =
      typeof raw.body === "string" && stripUnsafeText(raw.body) !== ""
        ? stripUnsafeText(raw.body).slice(0, BODY_MAX)
        : undefined;
    const severity = SEVERITIES.includes(
      raw.severity as (typeof SEVERITIES)[number],
    )
      ? (raw.severity as (typeof SEVERITIES)[number])
      : "info";
    const wsId =
      typeof raw.wsId === "string" && raw.wsId !== "" ? raw.wsId : undefined;
    const dockTab =
      typeof raw.dockTab === "string" && raw.dockTab !== ""
        ? raw.dockTab
        : undefined;
    const cleanTag =
      typeof raw.tag === "string" ? stripUnsafeText(raw.tag) : "";
    const tag =
      cleanTag !== ""
        ? `plugin:${manifest.id}:${cleanTag.slice(0, TAG_MAX)}`
        : undefined;

    deliver({
      pluginId: manifest.id,
      title: title.slice(0, TITLE_MAX),
      severity,
      ...(body !== undefined ? { body } : {}),
      ...(wsId !== undefined ? { wsId } : {}),
      ...(dockTab !== undefined ? { dockTab } : {}),
      ...(tag !== undefined ? { tag } : {}),
    });
  };
}
