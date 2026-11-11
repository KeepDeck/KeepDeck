import { describe, expect, it } from "vitest";
import { usageEvent, type UsageRowOverrides } from "../../domain/usage/history/event.testSupport";
import type { StatsDimension } from "../../domain/usage/stats/dimensions";
import { inZone } from "../../domain/usage/time.testSupport";
import { breakdownView, perModelNote, type BreakdownOrder } from "./breakdownView";

const at = (iso: string) => new Date(iso).getTime();
const NOW = at("2026-11-10T21:00:00+02:00");
const THIS_WEEK = at("2026-11-09T10:00:00+02:00");
const LAST_WEEK = at("2026-11-02T10:00:00+02:00");

function view(
  rows: UsageRowOverrides[],
  { dimension = "workspace", order = "cost", open = null, perModelSince = null }: {
    dimension?: StatsDimension;
    order?: BreakdownOrder;
    open?: string | null;
    perModelSince?: number | null;
  } = {},
) {
  let result: ReturnType<typeof breakdownView> | undefined;
  inZone("Asia/Nicosia", () => {
    result = breakdownView(rows.map((row) => usageEvent({ occurredAt: THIS_WEEK, ...row })), {
      period: 7, now: NOW, dimension, order, open, colors: new Map([["claude", "#111111"]]), perModelSince,
    });
  });
  if (result === undefined) throw new Error("no view");
  return result;
}

describe("the Breakdown table", () => {
  it("ranks the groups by money, each against itself in the days before", () => {
    const shown = view([
      { workspaceName: "A", costUsd: 30 },
      { workspaceName: "B", costUsd: 10 },
      { workspaceName: "A", costUsd: 60, occurredAt: LAST_WEEK },
    ]);
    expect(shown.rows.map((row) => [row.name, row.cost, row.shareText, row.change?.text ?? row.noChange])).toEqual([
      ["A", "≈$30.00", "75%", "↓ 50%"],
      // Nothing before to compare with: a dash, never a made-up +∞.
      ["B", "≈$10.00", "25%", "—"],
    ]);
    // The widest group fills its track; the rest are measured against it.
    expect(shown.rows.map((row) => row.width)).toEqual([1, 1 / 3]);
  });

  it("orders by the biggest rise when asked, groups without a change after, the closing row last", () => {
    const rows = [
      { workspaceName: "Steady", costUsd: 50 }, { workspaceName: "Steady", costUsd: 50, occurredAt: LAST_WEEK },
      { workspaceName: "Rising", costUsd: 20 }, { workspaceName: "Rising", costUsd: 10, occurredAt: LAST_WEEK },
      { workspaceName: "New", costUsd: 40 },
    ];
    expect(view(rows, { order: "change" }).rows.map((row) => row.name)).toEqual(["Rising", "Steady", "New"]);
    expect(view(rows).rows.map((row) => row.name)).toEqual(["Steady", "New", "Rising"]);
  });

  it("splits a group's bar by agent, in a fixed order and the series colours", () => {
    const [row] = view([
      { agent: "codex", costUsd: 1 },
      { agent: "claude", costUsd: 3 },
    ]).rows;
    expect(row?.split).toEqual([
      { agent: "claude", color: "#111111", weight: 3 },
      { agent: "codex", color: "#596273", weight: 1 },
    ]);
  });

  it("opens a group into its sessions, and closes it on a second click", () => {
    const rows = ["s1", "s2", "s3", "s4", "s5"].map((sessionId, i) => ({ sessionId, paneName: sessionId, costUsd: 9 - i }));
    const closed = view(rows);
    const [group] = closed.rows;
    expect(group).toMatchObject({ opens: true, open: false, sessions: [] });
    const opened = view(rows, { open: group?.toggle ?? null });
    const [openGroup] = opened.rows;
    expect(openGroup?.open).toBe(true);
    expect(openGroup?.toggle).toBeNull();
    // Three sessions and a closing row; no change is claimed under a group.
    expect(openGroup?.sessions.map((session) => [session.name, session.change, session.noChange])).toEqual([
      ["s1", null, null], ["s2", null, null], ["s3", null, null], ["2 more", null, null],
    ]);
  });

  it("names a session by its pane and where it ran, and never opens it further", () => {
    const [row] = view([{ paneName: "auth-refactor", workspaceName: "KeepDeck", agent: "codex", costUsd: 1 }], {
      dimension: "session",
    }).rows;
    expect(row).toMatchObject({ name: "auth-refactor", source: "KeepDeck · codex", opens: false });
  });

  it("heads the columns for the dimension, and offers every dimension and order", () => {
    const shown = view([{ costUsd: 1 }], { dimension: "model" });
    expect(shown.columns.name).toBe("Model ▸ Session");
    expect(view([{ costUsd: 1 }], { dimension: "session" }).columns.name).toBe("Session");
    expect(shown.dimensions.items.map((item) => [item.label, item.active])).toEqual([
      ["Workspace", false], ["Agent", false], ["Model", true], ["Session", false],
    ]);
    expect(shown.orders.items.map((item) => item.label)).toEqual(["By cost", "By change"]);
  });

  it("notes the per-model switch under model groups alone", () => {
    const rows = [{ costUsd: 1 }];
    const since = THIS_WEEK + 1;
    const notes = view(rows, { dimension: "model", perModelSince: since }).notes;
    expect(notes[notes.length - 1]).toMatch(/^Since /);
    expect(view(rows, { dimension: "workspace", perModelSince: since }).notes).toHaveLength(1);
  });
});

describe("perModelNote", () => {
  const SINCE = Date.UTC(2026, 10, 4, 18);

  it("speaks only when the period reaches back past the switch", () => {
    expect(perModelNote(SINCE, SINCE - 1)).toBe(
      "Since Nov 4, 2026, an agent that reports each model's own tokens is listed by " +
        "model id, and a session's cost under the model it ran on. Earlier usage keeps " +
        "the model names shown at the time.",
    );
    expect(perModelNote(SINCE, SINCE)).toBeNull();
    expect(perModelNote(null, SINCE - 1)).toBeNull();
    expect(perModelNote(SINCE, null)).toBeNull();
  });
});
