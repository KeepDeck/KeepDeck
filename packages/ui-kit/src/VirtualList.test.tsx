// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualList } from "./VirtualList";
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

  describe("a list that grows at its foot (followEnd)", () => {
    const thread = Array.from({ length: 30 }, (_, i) => `row ${i}`);
    const renderThread = (list: readonly string[], easeKey?: unknown, followEnd = true) =>
      act(() =>
        root.render(
          createElement(VirtualList<string>, {
            items: list,
            itemKey: (item) => item,
            estimate: () => ROW,
            render: (item) => createElement("span", { className: "row" }, item),
            className: "list",
            followEnd,
            easeKey,
          }),
        ),
      );
    const list = () => host.querySelector<HTMLElement>(".list")!;
    const scrollTo = (top: number) =>
      act(() => {
        list().scrollTop = top;
        list().dispatchEvent(new Event("scroll"));
      });

    it("keeps the newest row in sight while the view stands at the end", () => {
      restore = pinListViewport("list", 200, 300, ROW);
      renderThread(thread);
      scrollTo(30 * ROW - 200);
      renderThread([...thread, "row 30"]);
      expect(list().scrollTop).toBe(31 * ROW - 200);
    });

    it("moves nothing for a view scrolled away from the end — nor at the first paint", () => {
      restore = pinListViewport("list", 200, 300, ROW);
      renderThread(thread);
      expect(list().scrollTop).toBe(0);
      scrollTo(5 * ROW);
      renderThread([...thread, "row 30"]);
      expect(list().scrollTop).toBe(5 * ROW);
    });

    it("never follows a flag older than the layout: rows measured taller than their guess grew the list unscrolled", () => {
      // Guessed 20 tall, measured 60: at mount the guess fits the box, the measure does not.
      restore = pinListViewport("list", 200, 300, 60);
      const few = thread.slice(0, 5);
      renderThread(few);
      expect(list().scrollTop).toBe(0);
      // A render with the same rows (a keystroke elsewhere) must not jump to the foot.
      renderThread([...few]);
      expect(list().scrollTop).toBe(0);
    });

    it("leaves the person's own change where the fold holds it — and there, on the next render after it played", async () => {
      restore = pinListViewport("list", 200, 300, ROW);
      const token = {};
      renderThread(thread, token);
      scrollTo(30 * ROW - 200);
      const opened = {};
      const grown = [...thread, "row 30", "row 31", "row 32", "row 33", "row 34", "row 35", "row 36", "row 37", "row 38", "row 39"];
      renderThread(grown, opened);
      // The fold plays out: the list grows under the view, no scroll event.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 700));
      });
      const held = list().scrollTop;
      expect(list().scrollHeight).toBe(40 * ROW);
      renderThread([...grown], opened);
      expect(list().scrollTop).toBe(held);
    });

    it("follows nothing once the list stops following", () => {
      restore = pinListViewport("list", 200, 300, ROW);
      renderThread(thread);
      scrollTo(30 * ROW - 200);
      renderThread([...thread, "row 30"], undefined, false);
      expect(list().scrollTop).toBe(30 * ROW - 200);
    });

    it("lets go of the foot when the person scrolls up after a follow", () => {
      restore = pinListViewport("list", 200, 300, ROW);
      renderThread(thread);
      scrollTo(30 * ROW - 200);
      renderThread([...thread, "row 30"]);
      scrollTo(10 * ROW);
      renderThread([...thread, "row 30", "row 31"]);
      expect(list().scrollTop).toBe(10 * ROW);
    });

    it("lets go of the foot when the person opens a fold there: they read what it opened", async () => {
      restore = pinListViewport("list", 200, 300, ROW);
      const shut = {};
      renderThread(thread, shut);
      scrollTo(30 * ROW - 200);
      const once = [...thread, "row 30"];
      renderThread(once, shut);
      // The person opens a fold at the foot; it plays out.
      const open = {};
      const opened = [...once, ...Array.from({ length: 10 }, (_, i) => `row ${31 + i}`)];
      renderThread(opened, open);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 700));
      });
      const reading = list().scrollTop;
      // A row arrives from someone else: the view stays on what they read.
      renderThread([...opened, "row 41"], open);
      expect(list().scrollTop).toBe(reading);
    });

    it("lets go of the foot on a slow scroll up, a pixel at a time", () => {
      restore = pinListViewport("list", 200, 300, ROW);
      renderThread(thread);
      scrollTo(30 * ROW - 200);
      renderThread([...thread, "row 30"]);
      const foot = list().scrollTop;
      for (let step = 1; step <= 30; step++) scrollTo(foot - step);
      renderThread([...thread, "row 30", "row 31"]);
      expect(list().scrollTop).toBe(foot - 30);
    });

    it("keeps no hold through a spell of not following: back on, it follows from where the view is", () => {
      restore = pinListViewport("list", 200, 300, ROW);
      renderThread(thread);
      scrollTo(30 * ROW - 200);
      const once = [...thread, "row 30"];
      renderThread(once);
      scrollTo(31 * ROW - 200);
      renderThread(once, undefined, false);
      scrollTo(5 * ROW);
      renderThread(once, undefined, true);
      renderThread([...once, "row 31"]);
      expect(list().scrollTop).toBe(5 * ROW);
    });

    it("keeps no foot through a spell of not following, even when rows arrive meanwhile", () => {
      restore = pinListViewport("list", 200, 300, ROW);
      renderThread(thread);
      scrollTo(30 * ROW - 200);
      const once = [...thread, "row 30"];
      renderThread(once);
      scrollTo(31 * ROW - 200);
      renderThread(once, undefined, false);
      scrollTo(5 * ROW);
      // A row arrives while it does not follow; then it follows again with those rows.
      const twice = [...once, "row 31"];
      renderThread(twice, undefined, false);
      renderThread(twice, undefined, true);
      expect(list().scrollTop).toBe(5 * ROW);
      renderThread([...twice, "row 32"]);
      expect(list().scrollTop).toBe(5 * ROW);
    });

    it("follows a second row arriving while the first is still measured toward the foot", () => {
      // Guessed 20 tall, measured 100: the first follow lands short of the real foot.
      restore = pinListViewport("list", 200, 300, 100);
      const few = thread.slice(0, 3);
      renderThread(few);
      scrollTo(list().scrollHeight - 200);
      renderThread([...few, "row 3"]);
      const first = list().scrollTop;
      renderThread([...few, "row 3", "row 4"]);
      expect(list().scrollTop).toBeGreaterThan(first);
    });

    it("never moves the view while the person's own fold plays out", async () => {
      restore = pinListViewport("list", 200, 300, ROW);
      renderThread(thread, {});
      scrollTo(30 * ROW - 200);
      const grown = [...thread, ...Array.from({ length: 10 }, (_, i) => `row ${30 + i}`)];
      renderThread(grown, {});
      const seen = [list().scrollTop];
      for (const wait of [80, 160, 400]) {
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, wait));
        });
        seen.push(list().scrollTop);
      }
      expect(new Set(seen).size).toBe(1);
    });

    it("leaves the person's own change where the fold holds it", () => {
      restore = pinListViewport("list", 200, 300, ROW);
      const token = {};
      renderThread(thread, token);
      scrollTo(30 * ROW - 200);
      renderThread([...thread, "row 30", "row 31"], {});
      // The fold holds the place the person acted at.
      expect(list().scrollTop).toBe(30 * ROW - 200);
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

  const render = (list: readonly G[], easeKey?: unknown, revealKey: string | null = null) =>
    act(() =>
      root.render(
        createElement(VirtualList<G>, {
          items: list,
          easeKey,
          revealKey,
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
    // A pixel at a time through the push, every step between renders of
    // the window: the pinned heading follows the scroll, not the renders.
    for (let into = 1; into < H; into++) {
      await scrollTo(22 * H - H + into);
      expect(pinned()).toBe("group 1");
      expect(shift()).toBe(`translateY(${-into}px)`);
    }
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

  describe("the person's fold, played out by the list (useFoldMotion)", () => {
    const shut = new Set([9]);
    const box = () => host.querySelector<HTMLElement>(".list > div:not(:first-child) > div[style*='overflow: clip']");
    /** Frames of the clock, by time. */
    const frames = async (ms: number) => {
      await act(async () => {
        vi.advanceTimersByTime(ms);
      });
    };
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance", "setTimeout", "clearTimeout"] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("unrolls an opened group from under its heading — even with the next heading far off screen — and ends final", async () => {
      // Read near the top: group 9 is far below, its next heading further.
      render(grouped(30, shut), shut);
      await scrollTo(95 * H);
      const open = new Set<number>();
      render(grouped(30), open);
      // A box under the heading, at nothing yet: what is below has not moved.
      expect(box()).not.toBeNull();
      expect(box()!.style.height).toBe("0px");
      await frames(80);
      const mid = Number.parseFloat(box()!.style.height);
      expect(mid).toBeGreaterThan(0);
      expect(mid).toBeLessThan(10 * H);
      await frames(200);
      // Done: no box, the layout final — the group's rows in their places.
      expect(box()).toBeNull();
      expect(top("g9r0") + list().scrollTop).toBe(100 * H);
    });

    it("rolls a shut group up into its heading, its rows drawn as ghosts until it is done", async () => {
      const open = new Set<number>();
      render(grouped(30), open);
      await scrollTo(95 * H);
      render(grouped(30, shut), shut);
      const ghosts = () => [...host.querySelectorAll<HTMLElement>("[aria-hidden='true'][inert]")].map((g) => g.textContent);
      expect(ghosts()).toContain("g9r0");
      await frames(80);
      expect(Number.parseFloat(box()!.style.height)).toBeLessThan(10 * H);
      await frames(200);
      expect(box()).toBeNull();
      expect(ghosts()).toEqual([]);
    });

    it("walks the scroll the hold asks for over the fold — and lets the person's own scroll win", async () => {
      // Group 9's heading scrolled up past the top: opening brings it down.
      render(grouped(30, shut), shut);
      await scrollTo(99 * H + 15);
      render(grouped(30), new Set<number>());
      await frames(48);
      const walking = list().scrollTop;
      expect(walking).toBeLessThan(99 * H + 15);
      expect(walking).toBeGreaterThan(99 * H);
      // The person scrolls (a scrollbar drag, keys): a scroll the clock did
      // not write — the walk is theirs no more.
      await act(async () => {
        list().scrollTop = 50 * H;
        list().dispatchEvent(new Event("scroll"));
      });
      await frames(200);
      expect(list().scrollTop).toBe(50 * H);
    });

    it("moves the walk with a compensation for someone else's rows landing above — the heading still ends at the top", async () => {
      render(grouped(30, shut), shut);
      await scrollTo(99 * H + 15);
      const open = new Set<number>();
      const opened = grouped(30);
      render(opened, open);
      await frames(48);
      // An agent puts five tasks at the top of group 0, far above.
      const landed = [opened[0], ...Array.from({ length: 5 }, (_, i) => ({ key: `new${i}`, head: false, group: 0 })), ...opened.slice(1)];
      render(landed, open);
      await frames(200);
      expect(top("head:9")).toBe(0);
      expect(list().scrollTop).toBe(104 * H);
    });

    it("lets go of the walk the moment the person reaches for the wheel, before the scroll even moves", async () => {
      render(grouped(30, shut), shut);
      await scrollTo(99 * H + 15);
      render(grouped(30), new Set<number>());
      await frames(48);
      const held = list().scrollTop;
      await act(async () => {
        list().dispatchEvent(new Event("wheel"));
      });
      await frames(200);
      expect(list().scrollTop).toBe(held);
    });

    it("pins the heading of the group shutting while its ghosts still fill the top", async () => {
      // Reading deep in group 9 (its rows from 100·H), then shutting it.
      const open = new Set<number>();
      render(grouped(30), open);
      await scrollTo(100 * H + 3 * H);
      expect(pinned()).toBe("group 9");
      render(grouped(30, shut), shut);
      await frames(16);
      expect(pinned()).toBe("group 9");
    });

    it("lands the fold before a reveal moves the scroll", async () => {
      render(grouped(30, shut), shut);
      await scrollTo(95 * H);
      render(grouped(30), new Set<number>());
      expect(box()).not.toBeNull();
      render(grouped(30), new Set<number>(), "g20r5");
      expect(box()).toBeNull();
    });

    it("keeps unrolling through an agent's change — a row moved elsewhere lands still, the fold goes on", async () => {
      render(grouped(30, shut), shut);
      await scrollTo(95 * H);
      const open = new Set<number>();
      const opened = grouped(30);
      render(opened, open);
      await frames(48);
      const moved = opened.filter((g) => g.key !== "g20r0");
      moved.splice(1, 0, { key: "g20r0", head: false, group: 0 });
      render(moved, open);
      expect(box()).not.toBeNull();
      await frames(200);
      expect(box()).toBeNull();
      expect(top("g9r0") + list().scrollTop).toBe(101 * H);
    });

    it("turns a group folded back mid-way round from where it has got to — no snap shut first", async () => {
      render(grouped(30, shut), shut);
      await scrollTo(95 * H);
      render(grouped(30), new Set<number>());
      await frames(48);
      const opened = Number.parseFloat(box()!.style.height);
      expect(opened).toBeGreaterThan(0);
      // Shut again before it is open: the box goes on from that height.
      render(grouped(30, shut), new Set(shut));
      expect(Number.parseFloat(box()!.style.height)).toBeCloseTo(opened);
      await frames(300);
      expect(box()).toBeNull();
    });

    it("lets a fold elsewhere play on while the next one starts", async () => {
      render(grouped(30, new Set([9, 10])), new Set([9, 10]));
      await scrollTo(95 * H);
      render(grouped(30, new Set([10])), new Set([10]));
      await frames(48);
      render(grouped(30), new Set<number>());
      // Two boxes: group 9 still unrolling, group 10 just begun.
      expect(host.querySelectorAll(".list > div:not(:first-child) > div[style*='overflow: clip']").length).toBe(2);
      await frames(300);
      expect(box()).toBeNull();
    });

    it("lands a fold in flight the moment reduced motion is asked for", async () => {
      const listeners: ((event: { matches: boolean }) => void)[] = [];
      const original = window.matchMedia;
      window.matchMedia = ((query: string) =>
        ({
          matches: false,
          media: query,
          addEventListener: (_: string, fn: (event: { matches: boolean }) => void) => listeners.push(fn),
          removeEventListener: () => {},
        }) as unknown as MediaQueryList) as typeof window.matchMedia;
      try {
        render(grouped(30, shut), shut);
        await scrollTo(95 * H);
        render(grouped(30), new Set<number>());
        await frames(16);
        expect(box()).not.toBeNull();
        await act(async () => {
          for (const fn of listeners) fn({ matches: true });
        });
        expect(box()).toBeNull();
      } finally {
        window.matchMedia = original;
      }
    });

    it("clips its boxes without making them scroll containers, so the wheel stays the list's", async () => {
      render(grouped(30, shut), shut);
      await scrollTo(95 * H);
      render(grouped(30), new Set<number>());
      expect(box()!.style.overflow).toBe("clip");
    });

    it("lands at once under reduced motion", async () => {
      const original = window.matchMedia;
      window.matchMedia = ((query: string) => ({ matches: query.includes("reduce") }) as MediaQueryList) as typeof window.matchMedia;
      try {
        render(grouped(30, shut), shut);
        await scrollTo(95 * H);
        render(grouped(30), new Set<number>());
        expect(box()).toBeNull();
      } finally {
        window.matchMedia = original;
      }
    });
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
