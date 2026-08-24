// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { AgentTranscriptEntry } from "@keepdeck/plugin-api";
import type { SessionsBrowserApi } from "./useSessionsBrowser";
import { useTranscriptReading, type TranscriptReading } from "./useTranscriptReading";

/**
 * The reading, exercised WITHOUT a viewer.
 *
 * It moved out of the component so it could be witnessed as itself, and for a
 * while it was not: every witness ran through a full DOM render of the
 * surface that no longer owns it. Moving code for testability and then not
 * testing it leaves the move half-made — the file is in the right layer and
 * the proof is still borrowed from the wrong one.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const LIVE = "/index/live";
const DEAD = "/journal/dead";

const entry = (text: string): AgentTranscriptEntry => ({ role: "user", text });

const page = (from: number, count: number) =>
  Array.from({ length: count }, (_, at) => entry(`turn ${from + at}`));

const settle = async () => {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
};

/** Ask for the next page and let it land.
 *
 * The FIRST ask after an opening is swallowed on purpose: the reading fetches
 * page zero itself, and a caller that fills a viewport on mount would
 * otherwise race it and fetch that page twice. Callers consume that no-op
 * without noticing; a test asking directly must know it is there. */
const askForMore = async (seen: { current: TranscriptReading | null }) => {
  await act(async () => seen.current?.more());
  await settle();
};

/** Mounts the hook alone and hands back its latest answer. */
async function mount(input: {
  root: Root;
  read: SessionsBrowserApi["transcript"];
  links: string[];
  opening?: object;
  markLinks?: (links: readonly string[], failed: boolean) => void;
  seq?: { current: number };
}) {
  const seen: { current: TranscriptReading | null } = { current: null };
  // Hoisted, not defaulted inline: these stand for things the app keeps
  // stable across renders, and a fresh one per render would describe a caller
  // that cannot exist.
  const opening = input.opening ?? {};
  const seq = input.seq ?? { current: 0 };
  const markLinks = input.markLinks ?? (() => {});
  function Probe() {
    seen.current = useTranscriptReading({
      read: input.read,
      agent: "claude",
      opening,
      links: input.links,
      seq,
      markLinks,
    });
    return null;
  }
  await act(async () => {
    input.root.render(createElement(Probe));
  });
  await settle();
  return seen;
}

describe("useTranscriptReading", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("reads the head of the union and reports what the page fell short by", async () => {
    const read = vi.fn<SessionsBrowserApi["transcript"]>(async () => ({
      entries: [entry("only turn")],
      shortfall: [{ kind: "bytes" as const, size: 900, readBytes: 100 }],
    }));

    const seen = await mount({ root, read, links: [LIVE] });

    expect(read.mock.calls[0]?.[1]).toBe(LIVE);
    expect(seen.current?.entries.map((e) => e.text)).toEqual(["only turn"]);
    expect(seen.current?.shortfall).toEqual([
      { kind: "bytes", size: 900, readBytes: 100 },
    ]);
    // A page shorter than the ask is the end of the reading.
    expect(seen.current?.exhausted).toBe(true);
  });

  it("walks past a handle that refuses and keeps serving from the one that answered", async () => {
    const read = vi.fn<SessionsBrowserApi["transcript"]>(
      async (_agent, reference, offset) => {
        if (reference === DEAD) throw new Error("journal gone");
        return { entries: page(offset, offset === 0 ? 50 : 3) };
      },
    );

    const seen = await mount({ root, read, links: [DEAD, LIVE] });
    await askForMore(seen); // consumed by the opening guard
    await askForMore(seen);

    const asked = read.mock.calls.map((call) => [call[1], call[2]]);
    // The dead handle is asked once, at the top of the walk, never again —
    // the advance outlives the page that made it.
    expect(asked.filter(([reference]) => reference === DEAD)).toHaveLength(1);
    expect(asked).toContainEqual([LIVE, 50]);
  });

  it("starts a fresh handle at the beginning instead of splicing onto the old one", async () => {
    // The union is two RECORDED strings for one session; nothing says they
    // name a byte-identical file. Handing the spare an offset the first
    // earned would stitch two readings into a conversation that never
    // happened — an invention, which is worse than a loss.
    const read = vi.fn<SessionsBrowserApi["transcript"]>(
      async (_agent, reference, offset) => {
        if (reference === DEAD) {
          if (offset === 0) return { entries: page(0, 50) };
          throw new Error("journal vanished mid-scroll");
        }
        return { entries: [entry("spare from the top")] };
      },
    );

    const seen = await mount({ root, read, links: [DEAD, LIVE] });
    await askForMore(seen); // consumed by the opening guard
    await askForMore(seen);

    const spareAsks = read.mock.calls
      .filter((call) => call[1] === LIVE)
      .map((call) => call[2]);
    expect(spareAsks).toEqual([0]);
    expect(seen.current?.entries.map((e) => e.text)).toEqual([
      "spare from the top",
    ]);
  });

  it("names the refusal only when the LAST handle refused, and marks the row then", async () => {
    const read = vi.fn<SessionsBrowserApi["transcript"]>(async () => {
      throw new Error("permission denied");
    });
    const markLinks = vi.fn();

    const seen = await mount({ root, read, links: [DEAD, LIVE], markLinks });

    expect(read).toHaveBeenCalledTimes(2);
    expect(seen.current?.error).toBe("permission denied");
    // Exhausted, so nothing asks again for a handle that just refused; the
    // retry comes from a fresh opening.
    expect(seen.current?.exhausted).toBe(true);
    expect(markLinks).toHaveBeenLastCalledWith([DEAD, LIVE], true);
  });

  it("retires the row's mark as soon as a handle answers", async () => {
    const read = vi.fn<SessionsBrowserApi["transcript"]>(async () => ({
      entries: [entry("read fine")],
    }));
    const markLinks = vi.fn();

    await mount({ root, read, links: [LIVE], markLinks });

    expect(markLinks).toHaveBeenLastCalledWith([LIVE], false);
  });

  it("drops a page belonging to an older reading", async () => {
    // Ordering, not cancellation: a slow first answer must not land under a
    // reading that replaced it.
    const resolvers = new Map<string, (page: { entries: AgentTranscriptEntry[] }) => void>();
    const read = vi.fn<SessionsBrowserApi["transcript"]>(
      (_agent, reference) =>
        new Promise((resolve) => {
          resolvers.set(reference, resolve);
        }),
    );
    const seq = { current: 0 };

    const seen = await mount({ root, read, links: [LIVE], seq });
    seq.current += 1;

    await act(async () => {
      resolvers.get(LIVE)!({ entries: [entry("stale page")] });
    });
    expect(seen.current?.entries).toEqual([]);
  });

  it("asks nothing more once the reading is over", async () => {
    const read = vi.fn<SessionsBrowserApi["transcript"]>(async () => ({
      entries: [entry("the only page")],
    }));

    const seen = await mount({ root, read, links: [LIVE] });
    await askForMore(seen);
    await askForMore(seen);

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("swallows exactly one ask per opening — the page it fetched itself", async () => {
    // A caller that fills a viewport on mount asks immediately, and the
    // opening read is already in flight. One no-op, not a policy of ignoring
    // the caller: the second ask is served.
    const read = vi.fn<SessionsBrowserApi["transcript"]>(
      async (_agent, _reference, offset) => ({ entries: page(offset, 50) }),
    );

    const seen = await mount({ root, read, links: [LIVE] });
    expect(read).toHaveBeenCalledTimes(1);

    await askForMore(seen);
    expect(read).toHaveBeenCalledTimes(1);

    await askForMore(seen);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1]?.[2]).toBe(50);
  });
});
