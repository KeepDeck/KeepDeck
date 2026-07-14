import type {
  PluginLogger,
  PluginManifest,
  PluginNotify,
  PluginNotifyInput,
} from "@keepdeck/plugin-api";
import type { GateMode } from "../capabilities/gate";

/** String caps — a notification is a glance, not a document. Anything longer
 * is cut, not refused: the message still reaches the user. */
const TITLE_MAX = 120;
const BODY_MAX = 500;
const TAG_MAX = 64;

/** Token bucket: an initial burst, then a slow steady refill. Chosen for the
 * legitimate shapes ("3 checks finished together", then quiet) while a loop
 * that notifies per tick dries up after the burst. */
const BUCKET_BURST = 3;
const REFILL_MS = 10_000; // one token per 10s

const SEVERITIES = ["info", "warning", "error"] as const;

/** What the port delivers to the app's notification center — the sanitized
 * input plus the host-owned origin fields. The port depends on this narrow
 * sink, not on the center, so it tests in isolation. */
export interface PluginNotificationSink {
  (delivery: {
    pluginId: string;
    title: string;
    body?: string;
    severity: (typeof SEVERITIES)[number];
    wsId?: string;
    dockTab?: string;
    /** Already namespaced `plugin:<id>:<tag>`. */
    tag?: string;
  }): void;
}

/**
 * Build one plugin's `ctx.notify` — the host side of the `notifications`
 * capability. Everything a plugin must not control happens here:
 *
 * - the capability check, in the gate's two tiers (built-in warns, external
 *   throws) — same policy as every service call;
 * - sanitization: only own, length-capped plain strings survive (an external
 *   input arrives as `unknown` over RPC — this is the single choke point for
 *   both tiers);
 * - the per-plugin token bucket: overflow is dropped and logged, never queued;
 * - namespacing: the delivered `tag` is `plugin:<id>:<tag>`, so one plugin
 *   can never replace another's entry, and `pluginId` comes from the
 *   manifest, never the input.
 */
export function createPluginNotifyPort(
  manifest: PluginManifest,
  opts: { mode: GateMode; log: PluginLogger; deliver: PluginNotificationSink },
): PluginNotify {
  const { mode, log, deliver } = opts;
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

  return (input: PluginNotifyInput) => {
    if (!declared) {
      const message =
        'notify requires a "notifications" capability, which the manifest does not declare';
      if (mode === "enforce") throw new Error(message);
      log.warn(message);
    }

    // External input is `unknown` in practice (it crossed the realm bridge):
    // trust nothing, keep only own plain-string fields, cap lengths.
    const raw: Record<string, unknown> =
      typeof input === "object" && input !== null
        ? (input as unknown as Record<string, unknown>)
        : {};
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (title === "") {
      log.warn("notify: dropped — a non-empty string title is required");
      return;
    }
    if (!takeToken(Date.now())) {
      log.warn(`notify: rate limit — dropped "${title.slice(0, 40)}"`);
      return;
    }
    const body =
      typeof raw.body === "string" && raw.body.trim() !== ""
        ? raw.body.trim().slice(0, BODY_MAX)
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
    const tag =
      typeof raw.tag === "string" && raw.tag !== ""
        ? `plugin:${manifest.id}:${raw.tag.slice(0, TAG_MAX)}`
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
