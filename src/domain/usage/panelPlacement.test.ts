import { describe, expect, it } from "vitest";

import { usagePanelLeft } from "./panelPlacement";

const WIDE = { panelWidth: 320, viewportWidth: 1400 };

describe("usagePanelLeft", () => {
  it("aligns to the chip that opened it", () => {
    // The bug this exists for: the panel hung off the whole row and stayed
    // put while the open account changed under it.
    expect(usagePanelLeft({ chipLeft: 600, groupLeft: 540, ...WIDE })).toBe(60);
    expect(usagePanelLeft({ chipLeft: 720, groupLeft: 540, ...WIDE })).toBe(180);
  });

  it("gives up the alignment rather than the panel", () => {
    // A chip near the right edge would trail its panel off-screen. Losing the
    // left alignment is a smaller lie than being unreadable.
    const left = usagePanelLeft({
      chipLeft: 1340,
      groupLeft: 1200,
      ...WIDE,
    });
    // Sits at viewport 1400 − 8 − 320 = 1072, i.e. 128 left of the group.
    expect(left).toBe(-128);
  });

  it("keeps the leading margin when the window cannot hold the panel", () => {
    // Narrower than the panel: clipped on the right rather than centred on
    // nothing.
    expect(
      usagePanelLeft({
        chipLeft: 40,
        groupLeft: 0,
        panelWidth: 320,
        viewportWidth: 200,
      }),
    ).toBe(8);
  });

  it("does not drift when the group starts at the window edge", () => {
    expect(usagePanelLeft({ chipLeft: 300, groupLeft: 0, ...WIDE })).toBe(300);
  });
});
