import { describe, expect, it } from "vitest";
import { layering, type LayeringInput } from "./layering";

/** Nothing up: one workspace, no form, no dialog, a docked dock with no tabs. */
const quiet: LayeringInput = {
  creating: false,
  workspaceCount: 1,
  dialogOpen: false,
  anyDialogOpen: false,
  statsOpen: false,
  statsTab: null,
  dockMode: "docked",
  dockTabs: 0,
  hasActive: true,
};
const at = (over: Partial<LayeringInput>) => layering({ ...quiet, ...over });

describe("layering", () => {
  it("counts nothing as up when nothing is", () => {
    expect(at({})).toEqual({
      modal: false,
      dockCovers: false,
      panesInteractive: true,
      stats: { open: false, tab: null, covered: false },
    });
  });

  it("(а) the zero-workspace form is not a modal layer and covers nothing", () => {
    // It renders in the deck overlay at z 10, under the top bar, the rail and
    // any portaled dialog: a flag that counted it claimed a layer the user
    // could tab straight past.
    const zero = at({ workspaceCount: 0, hasActive: false });
    expect(zero.modal).toBe(false);
    expect(zero.stats.covered).toBe(false);
    expect(zero.panesInteractive).toBe(true);
  });

  it("(б) the CREATE form is a modal layer and paints over the stats dialog", () => {
    const create = at({ creating: true, statsOpen: true });
    expect(create.modal).toBe(true);
    expect(create.stats.covered).toBe(true);
    expect(create.panesInteractive).toBe(false);
  });

  it("(в) a floating dock covers the panes only with tabs and a workspace", () => {
    expect(at({ dockMode: "floating", dockTabs: 2 }).dockCovers).toBe(true);
    expect(at({ dockMode: "floating", dockTabs: 0 }).dockCovers).toBe(false);
    expect(at({ dockMode: "docked", dockTabs: 2 }).dockCovers).toBe(false);
    expect(at({ dockMode: "floating", dockTabs: 2, hasActive: false }).dockCovers).toBe(false);
  });

  it("(г) the stats dialog is not covered by being open, nor by a router dialog — only by a transaction or the CREATE form", () => {
    // The mistake this pins: `covered = modal`. The modal flag contains the
    // stats dialog itself, and the stats branch of the probe went always
    // false — a deep link into the tab the user was looking at raised an OS
    // banner anyway.
    const open = at({ statsOpen: true, anyDialogOpen: true });
    expect(open.modal).toBe(true);
    expect(open.stats.covered).toBe(false);
    expect(at({ statsOpen: true, dialogOpen: true }).stats.covered).toBe(true);
    expect(at({ statsOpen: true, creating: true }).stats.covered).toBe(true);
  });

  it("(д) the panes lose keyboard focus to a modal and to a covering dock, separately", () => {
    expect(at({ dialogOpen: true }).panesInteractive).toBe(false);
    expect(at({ anyDialogOpen: true }).panesInteractive).toBe(false);
    expect(at({ dockMode: "floating", dockTabs: 1 }).panesInteractive).toBe(false);
    expect(at({ dockMode: "floating", dockTabs: 1 }).modal).toBe(false);
  });

  it("(е) carries the stats tab through as it is, for the probe to match", () => {
    expect(at({ statsOpen: true, statsTab: "usage" }).stats).toEqual({
      open: true,
      tab: "usage",
      covered: false,
    });
  });
});
