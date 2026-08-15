import { describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../workspaceInstance";
import {
  addNotification,
  BANNER_COOLDOWN_MS,
  bannerCooldownKey,
  bannerVerdict,
  clearNotifications,
  markAllRead,
  markRead,
  NOTIFICATIONS_CAP,
  unreadCount,
  type Notification,
} from "./notifications";

let seq = 0;
const ws1 = createWorkspaceInstance();
function make(over: Partial<Notification> = {}): Notification {
  seq += 1;
  return {
    id: `n-${seq}`,
    title: "t",
    severity: "info",
    source: {
      type: "pane",
      workspace: { id: "ws-1", instance: ws1 },
      paneId: "pane-1",
    },
    at: seq,
    ...over,
  };
}

describe("addNotification", () => {
  it("prepends, newest first", () => {
    const a = make();
    const b = make();
    const items = addNotification(addNotification([], a), b);
    expect(items.map((n) => n.id)).toEqual([b.id, a.id]);
  });

  it("replaces a same-tag predecessor instead of stacking", () => {
    const a = make({ tag: "pane:1:crash" });
    const between = make();
    const b = make({ tag: "pane:1:crash" });
    const items = addNotification(
      addNotification(addNotification([], a), between),
      b,
    );
    expect(items.map((n) => n.id)).toEqual([b.id, between.id]);
  });

  it("a replacement arrives unread even when the old entry was read", () => {
    const a = make({ tag: "x", readAt: 5 });
    const b = make({ tag: "x" });
    const items = addNotification([a], b);
    expect(items).toHaveLength(1);
    expect(items[0].readAt).toBeUndefined();
  });

  it("keeps untagged notifications independent", () => {
    const a = make();
    const b = make();
    expect(addNotification([a], b)).toHaveLength(2);
  });

  it("trims the oldest past the cap", () => {
    let items: readonly Notification[] = [];
    const first = make();
    items = addNotification(items, first);
    for (let i = 0; i < NOTIFICATIONS_CAP; i += 1) {
      items = addNotification(items, make());
    }
    expect(items).toHaveLength(NOTIFICATIONS_CAP);
    expect(items.some((n) => n.id === first.id)).toBe(false);
  });
});

describe("bannerCooldownKey", () => {
  const otherPane = {
    type: "pane",
    workspace: { id: "ws-9", instance: ws1 },
    paneId: "pane-9",
  } as const;

  it("a tag names the unit; the source is ignored beneath it", () => {
    expect(bannerCooldownKey({ tag: "x", source: make().source })).toBe(
      `tag:x`,
    );
  });

  it("an untagged pane entry cools on its pane; panes never share", () => {
    const source = make().source;
    expect(bannerCooldownKey({ source })).toBe("pane:pane-1");
    expect(bannerCooldownKey({ source: otherPane })).toBe("pane:pane-9");
    expect(bannerCooldownKey({ source })).not.toBe(
      bannerCooldownKey({ source: otherPane }),
    );
    // The pane ALONE names the unit — its workspace is not part of the
    // key (pane ids are minted from one deck-wide sequence).
    const relocated = {
      type: "pane",
      workspace: { id: "ws-2", instance: ws1 },
      paneId: "pane-1",
    } as const;
    expect(bannerCooldownKey({ source: relocated })).toBe(
      bannerCooldownKey({ source }),
    );
  });

  it("every other source kind has its own unit", () => {
    expect(
      bannerCooldownKey({ source: { type: "plugin", pluginId: "git" } }),
    ).toBe("plugin:git");
    expect(bannerCooldownKey({ source: { type: "app" } })).toBe("app");
    expect(bannerCooldownKey({ source: { type: "stats" } })).toBe("stats");
    // A plugin is ONE cooling unit no matter which workspace or dock tab
    // its entries point at — the same granularity the mute feature uses.
    expect(
      bannerCooldownKey({
        source: {
          type: "plugin",
          pluginId: "git",
          workspace: { id: "ws-1", instance: ws1 },
          dockTab: "changes",
        },
      }),
    ).toBe(
      bannerCooldownKey({ source: { type: "plugin", pluginId: "git" } }),
    );
  });
});

describe("read state", () => {
  it("markRead stamps one entry and leaves the rest", () => {
    const a = make();
    const b = make();
    const items = markRead([a, b], a.id, 100);
    expect(items.find((n) => n.id === a.id)?.readAt).toBe(100);
    expect(items.find((n) => n.id === b.id)?.readAt).toBeUndefined();
  });

  it("markRead is a same-reference no-op for unknown or already-read ids", () => {
    const a = make({ readAt: 1 });
    const items = [a];
    expect(markRead(items, a.id, 100)).toBe(items);
    expect(markRead(items, "missing", 100)).toBe(items);
  });

  it("markAllRead stamps everything unread, no-ops when nothing is", () => {
    const items = [make(), make({ readAt: 1 })];
    const next = markAllRead(items, 50);
    expect(next.every((n) => n.readAt !== undefined)).toBe(true);
    expect(markAllRead(next, 60)).toBe(next);
  });

  it("unreadCount counts only unread", () => {
    expect(unreadCount([make(), make({ readAt: 1 }), make()])).toBe(2);
  });

  it("clears history and no-ops by reference when already empty", () => {
    expect(clearNotifications([make(), make({ readAt: 1 })])).toEqual([]);
    const empty: readonly Notification[] = [];
    expect(clearNotifications(empty)).toBe(empty);
  });
});

describe("bannerVerdict", () => {
  const base = { windowFocused: false, sourceVisible: false, now: 10_000 };

  it("banners by default", () => {
    expect(bannerVerdict(base)).toBe("banner");
  });

  it("suppresses when the source is on screen in a focused window", () => {
    expect(
      bannerVerdict({ ...base, windowFocused: true, sourceVisible: true }),
    ).toBe("seen-in-place");
  });

  it("still banners when focused but the source is off screen", () => {
    expect(bannerVerdict({ ...base, windowFocused: true })).toBe("banner");
  });

  it("still banners when the source is visible but the window is not focused", () => {
    expect(bannerVerdict({ ...base, sourceVisible: true })).toBe("banner");
  });

  it("holds the per-tag cooldown, then releases it", () => {
    expect(
      bannerVerdict({
        ...base,
        lastBannerAt: base.now - BANNER_COOLDOWN_MS + 1,
      }),
    ).toBe("cooldown");
    expect(
      bannerVerdict({ ...base, lastBannerAt: base.now - BANNER_COOLDOWN_MS }),
    ).toBe("banner");
  });

  /** The two silences are not interchangeable: delivery accounting treats
   * "seen-in-place" as reaching the user and "cooldown" as reaching nobody,
   * so a boolean answer would let one be read as the other. */
  it("distinguishes the two ways a banner is withheld", () => {
    const seen = { ...base, windowFocused: true, sourceVisible: true };
    const fresh = { lastBannerAt: base.now - 1 };
    expect(bannerVerdict(seen)).toBe("seen-in-place");
    // Being on screen outranks the cooldown: the user DID see it.
    expect(bannerVerdict({ ...seen, ...fresh })).toBe("seen-in-place");
    expect(bannerVerdict({ ...base, ...fresh })).toBe("cooldown");
  });
});
