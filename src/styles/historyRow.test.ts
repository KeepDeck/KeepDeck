import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readStyles, ruleBody } from "./testSupport";

// The data row's layout contract, read from the shipped sources: the
// geometry no DOM can answer in happy-dom (tracks are never resolved
// there), so the SOURCE is the witness. Pinned exactly — both bands'
// templates, the clip side of the folder label, and the CAPACITY of
// those tracks against the panel that must hold them — because "almost
// the same template" is how the ragged rows came back the first time,
// and "it fit when we wrote it" is how they left the panel the second.
describe("history data row layout contract", () => {
  const css = readStyles("history.css");

  it("the main band is a grid with ONE explicit template shared by every row", () => {
    const rule = ruleBody(css, ".history__datarow");
    expect(rule["display"]).toBe("grid");
    // Whitespace-normalized, comments stripped: five tracks in order,
    // explicit — auto/max-content would size per row and rebuild the
    // same raggedness in new clothes. The ONLY stretchable track is
    // the name.
    const template = rule["grid-template-columns"].replace(/\s+/g, " ").trim();
    expect(template).toBe("7px 16px minmax(220px, 1fr) 72px 56px");
  });

  it("the metadata band is its own nested grid with ONE explicit template", () => {
    const rule = ruleBody(css, ".history__meta");
    expect(rule["display"]).toBe("grid");
    expect(rule["grid-column"]).toBe("1 / -1");
    const template = rule["grid-template-columns"].replace(/\s+/g, " ").trim();
    // The issues floor fits the LONGEST unwrappable label ("index
    // unreachable", "nothing to read") — wrapping breaks BETWEEN
    // chips, never through one. The cwd track is a definite positive
    // width capped at the old 180px budget; only the name stretches.
    expect(template).toBe("minmax(120px, 180px) 120px 64px 120px");
  });

  it("the folder label clips from the LEFT: scoped rtl on the clipping wrapper", () => {
    const rule = ruleBody(css, ".history__cwd .chip__label");
    expect(rule["direction"]).toBe("rtl");
    // The clipping itself is the chip's own label slot — the ellipsis
    // half of the pair must stand beside the rtl half.
    const chipCss = readStyles("chip.css");
    expect(ruleBody(chipCss, ".chip__label")["text-overflow"]).toBe(
      "ellipsis",
    );
    // And the direction NEVER leaks anywhere else in this sheet — one
    // declaration total; on the row or a slot it would reverse the
    // column order.
    const everyDirection = [
      ...css.matchAll(/(?<![-\w])direction\s*:\s*[^;}]+[;}]/g),
    ].map((m) => m[0].trim());
    expect(everyDirection).toEqual(["direction: rtl;"]);
  });

  // ── The capacity witness: arithmetic over the sources, no layout ──
  // The row must FIT the narrowest panel the app can be: every number
  // is read from where it lives (the window's minWidth, the setup
  // column's width rule, the list's border, the row's padding, the
  // bands' own templates and gaps) — change any of them and this
  // recomputes, and a violation reddens WITH ITS CAUSE NAMED.
  const px = (v: string) => Number.parseFloat(v);

  const parseTemplate = (selector: string) => {
    const rule = ruleBody(css, selector);
    const raw = rule["grid-template-columns"]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\s+/g, " ")
      .trim();
    // Split into tracks without tearing functions apart: a track may
    // be a bare length or minmax(a, b) whose args contain ", " —
    // rejoin on open parens until they close.
    const tracks: string[] = [];
    for (const part of raw.split(" ")) {
      const open = (tracks[tracks.length - 1]?.match(/\(/g) ?? []).length;
      const close = (tracks[tracks.length - 1]?.match(/\)/g) ?? []).length;
      if (tracks.length > 0 && open > close) {
        tracks[tracks.length - 1] += ` ${part}`;
      } else {
        tracks.push(part);
      }
    }
    const gap =
      px(rule["column-gap"] ?? "0") * Math.max(tracks.length - 1, 0);
    return { tracks, gap };
  };

  const trackFloor = (track: string): number => {
    if (track.startsWith("minmax(")) {
      return px(track.slice("minmax(".length).split(",")[0]);
    }
    return px(track);
  };

  it("both bands FIT the narrowest panel the window allows", () => {
    const tauri = JSON.parse(
      readFileSync("src-tauri/tauri.conf.json", "utf8"),
    ) as {
      app: { windows: Array<{ minWidth?: number }> };
    };
    const minWidth = tauri.app.windows[0]?.minWidth;
    if (minWidth === undefined) {
      throw new Error("window minWidth not found in tauri.conf.json");
    }

    const colRule = ruleBody(css, ".deck__setup-col");
    // width: min(720px, calc(100% - 48px)) — the panel's own width.
    const widthMatch = /min\((\d+)px,\s*calc\(100%\s*-\s*(\d+)px\)\)/.exec(
      colRule["width"],
    );
    if (!widthMatch) throw new Error("setup column width rule not parsed");
    const panelCap = px(widthMatch[1]);
    const panelMargin = px(widthMatch[2]);
    const panel = Math.min(panelCap, minWidth - panelMargin);

    const listBorder =
      px(ruleBody(css, ".history__list")["border"] ?? "0") * 2;
    const rowPadding = (() => {
      const p = ruleBody(css, ".history__row")["padding"]; // "10px 12px"
      const parts = p.split(/\s+/);
      return px(parts[1] ?? parts[0]) * 2;
    })();

    // Conservative reserve for a classic (non-overlay) scrollbar.
    const SCROLLBAR_RESERVE = 15;
    const available =
      panel - listBorder - rowPadding - SCROLLBAR_RESERVE;

    const main = parseTemplate(".history__datarow");
    const meta = parseTemplate(".history__meta");
    const need = (band: ReturnType<typeof parseTemplate>) =>
      band.tracks.reduce((sum, t) => sum + trackFloor(t), 0) + band.gap;

    const mainNeed = need(main);
    const metaNeed = need(meta);
    if (mainNeed > available) {
      throw new Error(
        `main band floors (${mainNeed}px over ${main.tracks.length} tracks + ${main.gap}px gaps) exceed the ${available}px available at the ${minWidth}px-min window (panel ${panel}px, list border ${listBorder}px, row padding ${rowPadding}px, scrollbar reserve ${SCROLLBAR_RESERVE}px)`,
      );
    }
    if (metaNeed > available) {
      throw new Error(
        `metadata band floors (${metaNeed}px over ${meta.tracks.length} tracks + ${meta.gap}px gaps) exceed the ${available}px available at the ${minWidth}px-min window (panel ${panel}px, list border ${listBorder}px, row padding ${rowPadding}px, scrollbar reserve ${SCROLLBAR_RESERVE}px)`,
      );
    }
    // The honest numbers, for the report: at the current sources the
    // main band needs 411px and the metadata band 454px of 679px.
    expect(mainNeed).toBeLessThanOrEqual(available);
    expect(metaNeed).toBeLessThanOrEqual(available);
  });
});
