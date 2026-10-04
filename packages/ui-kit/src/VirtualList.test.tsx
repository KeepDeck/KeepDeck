// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIST_MOTION_WINDOW_MS, VirtualList } from "./VirtualList";
import { installResizeObserver, pinListViewport } from "./virtualGeometry.test-support";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ROW = 20;
const items = Array.from({ length: 500 }, (_, i) => `row ${i}`);

describe("VirtualList", () => {
  let root: Root;
  let host: HTMLElement;
  let restore: () => void = () => {};

  beforeEach(() => {
    installResizeObserver();
    document.body.innerHTML = "<div id='host'></div>";
    host = document.getElementById("host")!;
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    restore();
  });

  const render = (onReachEnd?: () => void, list: readonly string[] = items) =>
    act(() =>
      root.render(
        createElement(VirtualList<string>, {
          items: list,
          itemKey: (item) => item,
          estimate: () => ROW,
          render: (item) => createElement("span", { className: "row" }, item),
          className: "list",
          role: "list",
          onReachEnd,
        }),
      ),
    );

  it("mounts only the rows in view and a few beyond, over a spacer the height of all", () => {
    restore = pinListViewport("list", 200, 300, ROW);
    render();
    const rows = host.querySelectorAll(".row");
    // Ten fit the viewport; the overscan adds a handful — never the 500.
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.length).toBeLessThan(40);
    expect(rows[0].textContent).toBe("row 0");
    const spacer = host.querySelector(".list > div") as HTMLElement;
    expect(spacer.style.height).toBe(`${500 * ROW}px`);
  });

  it("says when the end is in the window — at once for a list shorter than its viewport", () => {
    restore = pinListViewport("list", 200, 300, ROW);
    const onReachEnd = vi.fn();
    render(onReachEnd, items.slice(0, 5));
    expect(onReachEnd).toHaveBeenCalledTimes(1);
  });

  it("keeps quiet about the end while it is out of the window", () => {
    restore = pinListViewport("list", 200, 300, ROW);
    const onReachEnd = vi.fn();
    render(onReachEnd);
    expect(onReachEnd).not.toHaveBeenCalled();
  });

  it("is a ul/li list for a consumer whose stylesheet and readers expect one", () => {
    restore = pinListViewport("list", 200, 300, ROW);
    act(() =>
      root.render(
        createElement(VirtualList<string>, {
          items: items.slice(0, 3),
          itemKey: (item) => item,
          estimate: () => ROW,
          render: (item) => createElement("span", { className: "row" }, item),
          className: "list",
          ariaLabel: "Things",
          spacer: { as: "ul", className: "list__spacer" },
          item: { as: "li", className: "list__item" },
        }),
      ),
    );
    const spacer = host.querySelector(".list > ul.list__spacer") as HTMLElement;
    expect(spacer).toBeTruthy();
    // Named where a reader meets the list — the ul, not the generic box.
    expect(spacer.getAttribute("aria-label")).toBe("Things");
    expect(host.querySelector(".list")!.hasAttribute("aria-label")).toBe(false);
    expect(spacer.style.height).toBe(`${3 * ROW}px`);
    expect(host.querySelectorAll("ul.list__spacer > li.list__item > .row").length).toBe(3);
  });

  describe("the list's own motion (easeKey → data-easing, data-arriving)", () => {
    const renderList = (list: readonly string[], easeKey: unknown) =>
      act(() =>
        root.render(
          createElement(VirtualList<string>, {
            items: list,
            itemKey: (item) => item,
            estimate: () => ROW,
            render: (item) => createElement("span", { className: "row" }, item),
            className: "list",
            easeKey,
          }),
        ),
      );
    const easing = () => host.querySelector(".list")!.hasAttribute("data-easing");
    const arrived = () => [...host.querySelectorAll<HTMLElement>("[data-arriving]")].map((el) => el.textContent);

    it("moves only the change the consumer asked for, marking the items that joined there", () => {
      restore = pinListViewport("list", 200, 300, ROW);
      renderList(["a", "b", "c"], 1);
      // Nothing moves on the first paint.
      expect([easing(), arrived()]).toEqual([false, []]);
      // The person's act: the token changes with the items.
      renderList(["a", "x", "y", "b", "c"], 2);
      expect([easing(), arrived()]).toEqual([true, ["x", "y"]]);
      // A render of the same items keeps the marks: an entrance runs out.
      renderList(["a", "x", "y", "b", "c"], 2);
      expect(arrived()).toEqual(["x", "y"]);
      // An agent's change, the anchoring's: the items change, the token
      // does not — it lands still.
      renderList(["z", "a", "x", "y", "b", "c"], 2);
      expect([easing(), arrived()]).toEqual([false, []]);
    });

    it("drops the marks past their window, so a row the scroll mounts later never replays an entrance", async () => {
      restore = pinListViewport("list", 200, 300, ROW);
      vi.useFakeTimers();
      try {
        renderList(["a", "b"], 1);
        renderList(["a", "x", "b"], 2);
        expect(arrived()).toEqual(["x"]);
        act(() => void vi.advanceTimersByTime(LIST_MOTION_WINDOW_MS - 1));
        expect(arrived()).toEqual(["x"]);
        act(() => void vi.advanceTimersByTime(1));
        expect([easing(), arrived()]).toEqual([false, []]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("the item kept in view (revealKey)", () => {
    const renderRevealing = (revealKey: string | null, list: readonly string[] = items) =>
      act(() =>
        root.render(
          createElement(VirtualList<string>, {
            items: list,
            itemKey: (item) => item,
            estimate: () => ROW,
            render: (item) => createElement("span", { className: "row" }, item),
            className: "list",
            revealKey,
          }),
        ),
      );
    const list = () => host.querySelector<HTMLElement>(".list")!;
    // The scroll event a browser sends after a script scrolls — happy-dom
    // sends none, and the list learns where it stands from that event.
    const scrolled = () => act(() => void list().dispatchEvent(new Event("scroll")));

    it("scrolls just enough to show it when it changes — to the foot from above, to the top from below", () => {
      restore = pinListViewport("list", 200, 300, ROW);
      renderRevealing(null);
      renderRevealing("row 30");
      // Row 30 ends at 31 rows; a ten-row box shows it at its foot.
      expect(list().scrollTop).toBe(31 * ROW - 200);
      scrolled();
      renderRevealing("row 5");
      expect(list().scrollTop).toBe(5 * ROW);
    });

    it("reveals upward to just below a pinned heading, never under it", () => {
      restore = pinListViewport("list", 200, 300, ROW);
      const renderPinned = (revealKey: string | null) =>
        act(() =>
          root.render(
            createElement(VirtualList<string>, {
              items,
              itemKey: (item) => item,
              estimate: () => ROW,
              render: (item) => createElement("span", { className: "row" }, item),
              className: "list",
              revealKey,
              sticky: { className: "pinned", height: 30, render: () => "pinned", heads: () => false },
            }),
          ),
        );
      renderPinned(null);
      renderPinned("row 30");
      scrolled();
      renderPinned("row 20");
      // Row 20 starts at 400; the heading covers the box's top 30px.
      expect(list().scrollTop).toBe(20 * ROW - 30);
    });

    it("leaves the scroll alone for an item already in view", () => {
      restore = pinListViewport("list", 200, 300, ROW);
      renderRevealing("row 3");
      expect(list().scrollTop).toBe(0);
    });

    it("does not pull the list back on a render the key took no part in", async () => {
      restore = pinListViewport("list", 200, 300, ROW);
      renderRevealing("row 3");
      await act(async () => {
        list().scrollTop = 100 * ROW;
        list().dispatchEvent(new Event("scroll"));
      });
      renderRevealing("row 3", [...items]);
      expect(list().scrollTop).toBe(100 * ROW);
    });
  });

  describe("the keyboard's place when a focused row scrolls out", () => {
    const renderButtons = () =>
      act(() =>
        root.render(
          createElement(VirtualList<string>, {
            items,
            itemKey: (item) => item,
            estimate: () => ROW,
            render: (item) => createElement("button", { className: "row" }, item),
            className: "list",
          }),
        ),
      );
    const list = () => host.querySelector<HTMLElement>(".list")!;
    const scrollFar = async () => {
      await act(async () => {
        list().scrollTop = 400 * ROW;
        list().dispatchEvent(new Event("scroll"));
      });
      // The observer reports the removal in a microtask.
      await act(async () => {});
    };

    it("lands focus on the list when the focused row unmounts, so the next Tab enters a mounted row", async () => {
      restore = pinListViewport("list", 200, 300, ROW);
      renderButtons();
      const first = host.querySelector<HTMLButtonElement>(".row")!;
      act(() => first.focus());
      expect(document.activeElement).toBe(first);
      await scrollFar();
      expect(first.isConnected).toBe(false);
      expect(document.activeElement).toBe(list());
    });

    it("takes nothing when no row was focused — a plain scroll is not a handoff", async () => {
      restore = pinListViewport("list", 200, 300, ROW);
      renderButtons();
      await scrollFar();
      expect(document.activeElement).toBe(document.body);
    });

    it("does not take focus the person moved out of the list", async () => {
      restore = pinListViewport("list", 200, 300, ROW);
      const outside = document.body.appendChild(document.createElement("button"));
      renderButtons();
      act(() => host.querySelector<HTMLButtonElement>(".row")!.focus());
      act(() => outside.focus());
      await scrollFar();
      expect(document.activeElement).toBe(outside);
    });

    it("does not take focus that went elsewhere even when the list never heard it go", async () => {
      restore = pinListViewport("list", 200, 300, ROW);
      const outside = document.body.appendChild(document.createElement("button"));
      renderButtons();
      act(() => host.querySelector<HTMLButtonElement>(".row")!.focus());
      // A departure whose focusout the list does not see (another browsing
      // context reports no target): the memory stays, and only the
      // browser's own answer — focus is not on <body> — keeps the list off.
      const swallow = (e: Event) => e.stopPropagation();
      document.addEventListener("focusout", swallow, true);
      act(() => outside.focus());
      document.removeEventListener("focusout", swallow, true);
      await scrollFar();
      expect(document.activeElement).toBe(outside);
    });
  });
});

describe("VirtualList's measured heights", () => {
  // Rows measure 20 but are estimated at 50: a row still placed at the
  // estimate shows as a gap under a 20-pixel row.
  const MEASURED = 20;
  const ESTIMATE = 50;
  let root: Root;
  let host: HTMLElement;
  let restore: () => void = () => {};

  beforeEach(() => {
    installResizeObserver();
    document.body.innerHTML = "<div id='host'></div>";
    host = document.getElementById("host")!;
    root = createRoot(host);
    restore = pinListViewport("list", 200, 300, MEASURED);
  });

  afterEach(() => {
    act(() => root.unmount());
    restore();
  });

  const render = (list: readonly string[]) =>
    act(() =>
      root.render(
        createElement(VirtualList<string>, {
          items: list,
          itemKey: (item) => item,
          estimate: ESTIMATE,
          render: (item) => createElement("span", { className: "row" }, item),
          className: "list",
        }),
      ),
    );
  const list = () => host.querySelector<HTMLElement>(".list")!;
  /** Each mounted row's top, by its text. */
  const tops = () =>
    new Map(
      [...host.querySelectorAll<HTMLElement>(".list > div > div")].map((item) => [
        item.textContent!,
        Number(/translateY\((-?[\d.]+)px\)/.exec(item.style.transform)![1]),
      ]),
    );

  it("keeps them when rows land above the one being read", async () => {
    render(items);
    await act(async () => {
      list().scrollTop = 10 * MEASURED;
      list().dispatchEvent(new Event("scroll"));
    });
    const before = tops();
    const anchor = before.get("row 10")! - list().scrollTop;

    // A row lands at the top: the list holds row 10 where it was — and the
    // rows in view keep the heights they measured, rather than falling back
    // to the estimate and opening a gap under every one of them.
    render(["new row", ...items]);
    await act(async () => {});

    const after = tops();
    expect(after.get("row 10")! - list().scrollTop).toBe(anchor);
    for (let i = 10; i < 15; i++) {
      expect(after.get(`row ${i + 1}`)! - after.get(`row ${i}`)!).toBe(MEASURED);
    }
  });

  it("holds the row being read when the rows landing above it are measured in the same commit", async () => {
    // At the very top, the landed rows mount in the window and report their
    // real height before the anchoring runs. The anchoring must place the
    // row by those heights, not by the estimate it painted with a moment
    // earlier — or the row it holds lands a height difference per landed
    // row off its place.
    render(items);
    const anchor = tops().get("row 0")! - list().scrollTop;
    const landed = Array.from({ length: 5 }, (_, i) => `new ${i}`);

    render([...landed, ...items]);
    await act(async () => {});

    expect(tops().get("row 0")! - list().scrollTop).toBe(anchor);
  });

  /** A scroll, as a browser makes it: the offset moves and a scroll
   * event fires. */
  const scrollTo = async (top: number) => {
    await act(async () => {
      list().scrollTop = top;
      list().dispatchEvent(new Event("scroll"));
    });
  };
  // 205 → 212 moves neither the first nor the last row of the window
  // (rows are 20 tall, the viewport 200): the list does NOT re-render for
  // it, so arming never runs — the condition the bug lived in.
  const ARMED_AT = 205;
  const READ_AT = 212;

  it("leaves the scroll alone when the rows come again unchanged — no yank back", async () => {
    // The reported bug: a consumer hands a NEW array with the same rows
    // (git's changes list is rebuilt every render; a board column on any
    // tick) while the person has scrolled since the anchor was armed.
    // Nothing landed above, so nothing may move.
    render(items);
    await scrollTo(ARMED_AT);
    await scrollTo(READ_AT);
    render([...items]);
    await act(async () => {});
    expect(list().scrollTop).toBe(READ_AT);
  });

  it("holds the row being read where the person has it when rows land above", async () => {
    render(items);
    await scrollTo(ARMED_AT);
    await scrollTo(READ_AT);
    const before = tops().get("row 11")! - list().scrollTop;
    render(["new 0", "new 1", ...items]);
    await act(async () => {});
    // Where the PERSON had it — not where it stood at the last arming.
    expect(tops().get("row 11")! - list().scrollTop).toBe(before);
  });

  it("leaves the scroll alone when a page lands BELOW while the person is at the end", async () => {
    // Within a row of the end the first fully visible row starts past the
    // furthest the list can scroll: the library's aligned offset for it is
    // clamped to that maximum. Held from the clamped value, the anchor is
    // off by the clamp, and a page landing below (the reach-end paging)
    // pushed the scroll forward by it — a jolt that kills a trackpad's run.
    // A viewport off the rows' grid, as real heights are: the furthest
    // scroll (total − 210) falls mid-row.
    // Estimated true, so the end is where it will measure.
    restore();
    restore = pinListViewport("list", 210, 300, MEASURED);
    const renderTrue = (list: readonly string[]) =>
      act(() =>
        root.render(
          createElement(VirtualList<string>, {
            items: list,
            itemKey: (item) => item,
            estimate: MEASURED,
            render: (item) => createElement("span", { className: "row" }, item),
            className: "list",
          }),
        ),
      );
    renderTrue(items);
    const nearEnd = items.length * MEASURED - 210 - 5;
    await scrollTo(nearEnd - 3);
    await scrollTo(nearEnd);
    renderTrue([...items, ...Array.from({ length: 10 }, (_, i) => `more ${i}`)]);
    await act(async () => {});
    expect(list().scrollTop).toBe(nearEnd);
  });

  it("finds the row being read without walking the list on every scroll", async () => {
    // A scroll event re-reads the held row's offset; with tens of thousands
    // of rows (an opened node_modules) a scan per event is the cost, so the
    // row's last place is checked first.
    const keyOf = vi.fn((item: string) => item);
    act(() =>
      root.render(
        createElement(VirtualList<string>, {
          items,
          itemKey: keyOf,
          estimate: ESTIMATE,
          render: (item) => createElement("span", { className: "row" }, item),
          className: "list",
        }),
      ),
    );
    await scrollTo(ARMED_AT);
    await scrollTo(ARMED_AT + 3);
    keyOf.mockClear();
    await scrollTo(READ_AT);
    expect(keyOf.mock.calls.length).toBeLessThan(5);
  });

  it("holds the row being read after the one it held before was removed", async () => {
    // The held row leaves (a task moved to another column) while the scroll
    // and the window's end stand still — the row under it moves up into
    // its place. Rows landing above afterwards must not push THAT row away.
    render(items);
    await act(async () => {
      list().scrollTop = 10 * MEASURED;
      list().dispatchEvent(new Event("scroll"));
    });
    const withoutHeld = items.filter((item) => item !== "row 10");
    render(withoutHeld);
    await act(async () => {});
    const anchor = tops().get("row 11")! - list().scrollTop;

    render(["new 0", "new 1", ...withoutHeld]);
    await act(async () => {});

    expect(tops().get("row 11")! - list().scrollTop).toBe(anchor);
  });
});

describe("VirtualList as a grouped list", () => {
  // Groups of ten rows under a heading; every item 20 tall, a 200 window.
  const H = 20;
  type G = { key: string; head: boolean; group: number };
  const grouped = (groups: number, folded: ReadonlySet<number> = new Set()): G[] =>
    Array.from({ length: groups }, (_, g) => [
      { key: `head:${g}`, head: true, group: g },
      ...(folded.has(g) ? [] : Array.from({ length: 10 }, (_, r) => ({ key: `g${g}r${r}`, head: false, group: g }))),
    ]).flat();
  let root: Root;
  let host: HTMLElement;
  let restore: () => void = () => {};

  beforeEach(() => {
    installResizeObserver();
    document.body.innerHTML = "<div id='host'></div>";
    host = document.getElementById("host")!;
    root = createRoot(host);
    restore = pinListViewport("list", 200, 300, H);
  });

  afterEach(() => {
    act(() => root.unmount());
    restore();
  });

  const render = (list: readonly G[], easeKey?: unknown) =>
    act(() =>
      root.render(
        createElement(VirtualList<G>, {
          items: list,
          easeKey,
          itemKey: (g) => g.key,
          estimate: H,
          render: (g) => createElement("span", { className: g.head ? "head" : "row" }, g.key),
          className: "list",
          sticky: {
            className: "pinned",
            height: H,
            render: (first) => {
              for (let i = first; i >= 0; i--) if (list[i]?.head) return `group ${list[i].group}`;
              return null;
            },
            heads: (g) => g.head,
          },
        }),
      ),
    );
  const list = () => host.querySelector<HTMLElement>(".list")!;
  const pinned = () => host.querySelector(".pinned")?.textContent ?? null;
  const top = (key: string) => {
    const item = [...host.querySelectorAll<HTMLElement>(".list > div:not(:first-child) > div")].find(
      (el) => el.textContent === key,
    )!;
    return Number(/translateY\((-?[\d.]+)px\)/.exec(item.style.transform)![1]) - list().scrollTop;
  };
  const scrollTo = async (px: number) => {
    await act(async () => {
      list().scrollTop = px;
      list().dispatchEvent(new Event("scroll"));
    });
  };

  it("pins the heading of the first row in view, and moves on at a group's boundary", async () => {
    render(grouped(30));
    expect(pinned()).toBe("group 0");
    // Group 2 starts at item 22 (two groups of eleven before it).
    await scrollTo(22 * H + 5);
    expect(pinned()).toBe("group 2");
    await scrollTo(22 * H - 5);
    expect(pinned()).toBe("group 1");
  });

  it("lets the next heading push the pinned one up, by the part it has run into", async () => {
    render(grouped(30));
    const shift = () => host.querySelector<HTMLElement>(".pinned")!.style.transform;
    // Group 2's heading starts at 22·H; the pinned heading is H tall.
    await scrollTo(22 * H - 2 * H);
    expect(pinned()).toBe("group 1");
    expect(shift()).toBe("");
    await scrollTo(22 * H - 5);
    expect(pinned()).toBe("group 1");
    expect(shift()).toBe(`translateY(${5 - H}px)`);
    // Past the top: group 2's own heading is pinned, unpushed.
    await scrollTo(22 * H + 1);
    expect(pinned()).toBe("group 2");
    expect(shift()).toBe("");
  });

  it("keeps the row being read where it is when a group above it folds", async () => {
    render(grouped(30));
    await scrollTo(100 * H);
    await scrollTo(100 * H + 3);
    const before = top("g9r1");
    // Group 1, far above the window, folds to its heading.
    render(grouped(30, new Set([1])));
    await act(async () => {});
    expect(top("g9r1")).toBe(before);
  });

  it("keeps it there when the group unfolds again", async () => {
    render(grouped(30, new Set([1])));
    await scrollTo(90 * H);
    await scrollTo(90 * H + 3);
    const before = top("g9r1");
    render(grouped(30));
    await act(async () => {});
    expect(top("g9r1")).toBe(before);
  });

  it("keeps it there when a row moves from below it to a group above it", async () => {
    const base = grouped(30);
    render(base);
    await scrollTo(100 * H);
    await scrollTo(100 * H + 3);
    const before = top("g9r1");
    // g20r0 changes status: it leaves group 20 and joins group 0.
    const moved = base.filter((g) => g.key !== "g20r0");
    moved.splice(1, 0, { key: "g20r0", head: false, group: 0 });
    render(moved);
    await act(async () => {});
    expect(top("g9r1")).toBe(before);
  });

  it("holds the place when the heading it rests on is the one that folds", async () => {
    // The first row in view is group 9's heading; group 9 folds — its
    // heading stays in the list, so the place does not move.
    render(grouped(30));
    await scrollTo(99 * H);
    await scrollTo(99 * H + 1);
    const before = top("head:9");
    render(grouped(30, new Set([9])));
    await act(async () => {});
    expect(top("head:9")).toBe(before);
  });

  describe("the person's own fold (easeKey) holds the heading folded", () => {
    // Group 9 folded: its heading is item 99, at 99·H.
    const shut = new Set([9]);

    it("opens a group whose heading is scrolled up under the top edge BELOW it — the heading comes down to the top", async () => {
      render(grouped(30, shut), shut);
      await scrollTo(99 * H);
      await scrollTo(99 * H + 5);
      const open = new Set<number>();
      render(grouped(30), open);
      await act(async () => {});
      expect(top("head:9")).toBe(0);
      expect(top("g9r0")).toBe(H);
    });

    it("leaves the scroll alone when the heading opened is in view — the rows push down what is under it", async () => {
      render(grouped(30, shut), shut);
      await scrollTo(97 * H);
      await scrollTo(97 * H + 2);
      const before = top("head:9");
      const open = new Set<number>();
      render(grouped(30), open);
      await act(async () => {});
      expect(top("head:9")).toBe(before);
      expect(top("g9r0")).toBe(before + H);
    });

    it("shuts a group read deep inside onto its heading, at the top", async () => {
      const open = new Set<number>();
      render(grouped(30), open);
      await scrollTo(99 * H + 5 * H);
      await scrollTo(99 * H + 5 * H + 3);
      render(grouped(30, shut), shut);
      await act(async () => {});
      expect(top("head:9")).toBe(0);
      expect(top("head:10")).toBe(H);
    });

    it("holds nothing on a later change that was not the person's — the row being read stays", async () => {
      render(grouped(30, shut), shut);
      await scrollTo(99 * H + 5);
      const open = new Set<number>();
      render(grouped(30), open);
      await act(async () => {});
      await scrollTo(150 * H);
      await scrollTo(150 * H + 3);
      const before = top("g13r7");
      // The same rows again (a tick re-dated them), under the same token.
      render(grouped(30), open);
      await act(async () => {});
      expect(top("g13r7")).toBe(before);
      // An agent's move above, under the same token.
      const moved = grouped(30).filter((g) => g.key !== "g20r0");
      moved.splice(1, 0, { key: "g20r0", head: false, group: 0 });
      render(moved, open);
      await act(async () => {});
      expect(top("g13r7")).toBe(before);
    });
  });
});
