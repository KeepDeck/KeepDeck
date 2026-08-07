import { describe, expect, it } from "vitest";
import { readStyles, ruleBody } from "./testSupport";

/**
 * The team roster must not move under the cursor.
 *
 * A row grows a role field the moment it is ticked, so its height is not
 * constant unless the stylesheet makes it so — and the field carries
 * `.form__input`'s 20px bottom margin, which is correct for stacked fields
 * and dead space inside a flex row. Measured in the app, the two together
 * made every tick resize its row and shuffle the rows below it while
 * someone was clicking down the list.
 *
 * happy-dom lays nothing out and resolves no cascade, so the guard reads
 * the rules as text — the same way the Weeks columns are pinned.
 */

const team = readStyles("team.css");
const form = readStyles("form.css");

const ROW_CONTROLS = ".team__row-role,\n.team__row-agent";

describe("the team roster", () => {
  it("gives every row the same height, whichever list it is in", () => {
    // A row moves between the roster and the pool as agents are taken and
    // dropped. If its height changed with it, the rows below would shuffle
    // under the cursor mid-click.
    const row = ruleBody(team, ".team__row");
    expect(row["min-height"]).toBeDefined();
    // Tall enough for the role field it makes room for: padding, borders
    // and one line of text.
    expect(parseFloat(row["min-height"])).toBeGreaterThanOrEqual(30);
  });

  it("drops the stacked-field margin the row controls inherit", () => {
    // The margin is REAL on .form__input — this is not a redundant reset,
    // it is the row overriding a rule written for a different layout.
    expect(parseFloat(ruleBody(form, ".form__input")["margin-bottom"])).toBeGreaterThan(0);
    expect(parseFloat(ruleBody(team, ROW_CONTROLS)["margin-bottom"])).toBe(0);
  });

  it("keeps the role column a fixed width so the addresses line up", () => {
    // A column of addresses is what gets scanned for duplicates, and a
    // ragged one is harder to scan than a straight one.
    const controls = ruleBody(team, ROW_CONTROLS);
    expect(controls.width).toMatch(/^\d/);
    expect(controls.flex).toBe("none");
  });

  it("scrolls the dialog, never the lists inside it", () => {
    // Capping each list gave one dialog two separate little scroll boxes,
    // each with its own thumb — a shape that reads as broken before it
    // reads as scrollable — and put a scrollbar over the "Add" button the
    // pointer was heading for. The cap belongs to the dialog.
    const lists = ruleBody(team, ".team__roster,\n.team__pool");
    expect(lists["max-height"]).toBeUndefined();
    expect(lists["overflow-y"]).toBeUndefined();
    const dialog = ruleBody(team, ".team-form");
    expect(dialog["max-height"]).toBeDefined();
    expect(dialog["overflow-y"]).toBe("auto");
  });

  it("gives wrapped prose room to breathe", () => {
    // The app's default leading is `normal` (~1.2), which sets wrapped 12px
    // text almost solid. This is the only dialog whose prose explains a
    // concept rather than labelling a field, so it is the one that wraps.
    expect(parseFloat(ruleBody(team, ".team__desc,\n.team__empty")["line-height"]))
      .toBeGreaterThanOrEqual(1.4);
  });

  it("undoes the tuck-under-the-title margin at the two sites that reuse it", () => {
    // `.form__desc` and `.form__error` are positioned for life directly
    // under the dialog title. Here they follow a label and a button, and
    // the negative margin pulls each into whatever is above it.
    expect(parseFloat(ruleBody(form, ".form__desc")["margin-top"])).toBeLessThan(0);
    expect(parseFloat(ruleBody(form, ".form__error")["margin-top"])).toBeLessThan(0);
    expect(parseFloat(ruleBody(team, ".team__empty,\n.team__error")["margin-top"])).toBe(0);
  });
});
