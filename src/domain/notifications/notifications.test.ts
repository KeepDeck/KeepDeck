import { describe, expect, it } from "vitest";
import { createWorkspaceInstance } from "../workspaceInstance";
import {
  addNotification,
  BANNER_COOLDOWN_MS,
  bannerVerdict,
  markAllRead,
  markRead,
  NOTIFICATIONS_CAP,
  retractByTag,
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

describe("retractByTag", () => {
  it("withdraws the tag's slot — read or not — and leaves the rest", () => {
    const answered = make({ tag: "pane:1:activity", readAt: 5 });
    const other = make({ tag: "pane:2:activity" });
    const untagged = make();
    const next = retractByTag([answered, other, untagged], "pane:1:activity");
    expect(next).toEqual([other, untagged]);
  });

  it("is a same-reference no-op when the tag holds no slot", () => {
    const items = [make({ tag: "pane:2:activity" }), make()];
    expect(retractByTag(items, "pane:1:activity")).toBe(items);
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
