import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TERMINAL_FONT_SIZE, TERMINAL_LOG_FONT_SIZE, TERMINAL_THEME } from "@keepdeck/terminal-kit";
import * as chart from "../domain/usage/chartPalette";
import { readStyles, ruleBody, STYLES_DIR, stripComments } from "./testSupport";

/**
 * tokens.css is the one home of the chrome's colours. These hold the promises
 * that make that true: it loads before anything that reads it, the status
 * names every surface paints with resolve to its one palette, and the copies
 * that cannot say `var()` stay equal to it.
 */

const tokens = readStyles("tokens.css");

/** Every host sheet but tokens.css, and every built-in plugin's, comments
 * stripped — the plugins share this document and these tokens. */
function allSheets(): (readonly [string, string])[] {
  const pluginsDir = join(STYLES_DIR, "../../plugins");
  return [
    ...readdirSync(STYLES_DIR)
      .filter((f) => f.endsWith(".css") && f !== "tokens.css")
      .map((f) => [f, readStyles(f)] as const),
    ...readdirSync(pluginsDir).flatMap((plugin) => {
      const dir = join(pluginsDir, plugin, "src");
      try {
        return readdirSync(dir)
          .filter((f) => f.endsWith(".css"))
          .map((f) => [`${plugin}/${f}`, stripComments(readFileSync(join(dir, f), "utf8"))] as const);
      } catch {
        return [];
      }
    }),
  ];
}

function declared(css: string, name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
  if (!match) throw new Error(`${name} is not declared`);
  return match[1].trim();
}

/** WCAG 2 contrast ratio of two sRGB hexes. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const v = parseInt(hex.slice(i, i + 2), 16) / 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** OKLab lightness of an sRGB hex — the scale on which "a step the eye can
 * see" is measured. */
function lightness(hex: string): number {
  const linear = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [1, 3, 5].map((i) => linear(parseInt(hex.slice(i, i + 2), 16)));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return 0.2104542553 * l + 0.793617963 * m - 0.0040720468 * s;
}

describe("the design tokens", () => {
  it("load before every stylesheet that reads them", () => {
    const index = readFileSync(join(STYLES_DIR, "index.css"), "utf8");
    const imports = [...index.matchAll(/@import\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(imports[0]).toBe("./tokens.css");
  });

  it("give every agent-status name a hue from the one status palette", () => {
    const status = readStyles("status.css");
    expect(declared(status, "--status-working")).toBe("var(--kd-working)");
    expect(declared(status, "--status-waiting")).toBe("var(--kd-warn)");
    expect(declared(status, "--status-failed")).toBe("var(--kd-err)");
    expect(declared(status, "--status-done")).toBe("var(--kd-ok)");
    expect(declared(tokens, "--kd-info")).toBe("var(--kd-working)");
  });

  it("keep hover and the seam a step apart the eye can see", () => {
    // The old pair (#1b2230 hover, #1c2230 seam) differed by 0.001 — the
    // same colour twice. 0.03 is a comfortably visible step on near-black.
    const hover = lightness(declared(tokens, "--kd-hover"));
    const seam = lightness(declared(tokens, "--kd-seam"));
    expect(seam - hover).toBeGreaterThanOrEqual(0.03);
  });

  it("step every surface lighter than the one it sits on", () => {
    const ladder = ["--kd-canvas", "--kd-strip", "--kd-tile", "--kd-float", "--kd-hover", "--kd-selected", "--kd-seam", "--kd-seam-strong"]
      .map((name) => lightness(declared(tokens, name)));
    ladder.slice(1).forEach((l, i) => expect(l).toBeGreaterThan(ladder[i]));
  });

  it("set the UI in the bundled Inter, falling back to the system face", () => {
    expect(declared(tokens, "--kd-font-ui")).toMatch(/^"Inter Variable",\s*ui-sans-serif/);
    expect(declared(readStyles("base.css"), "font-family")).toBe("var(--kd-font-ui)");
    const app = readFileSync(join(STYLES_DIR, "..", "App.tsx"), "utf8");
    expect(app).toContain('import "@fontsource-variable/inter";');
  });

  it("keep --kd-text-3, the floor for readable text, readable on a tile and a hover", () => {
    const text3 = declared(tokens, "--kd-text-3");
    expect(contrast(text3, declared(tokens, "--kd-tile"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(text3, declared(tokens, "--kd-hover"))).toBeGreaterThanOrEqual(4);
  });

  it("paint every terminal on the tile, in the status palette's hues", () => {
    expect(TERMINAL_THEME.background).toBe(declared(tokens, "--kd-tile"));
    expect(TERMINAL_THEME.cursor).toBe(declared(tokens, "--kd-text"));
    expect(TERMINAL_THEME.red).toBe(declared(tokens, "--kd-err"));
    expect(TERMINAL_THEME.green).toBe(declared(tokens, "--kd-ok"));
    expect(TERMINAL_THEME.yellow).toBe(declared(tokens, "--kd-warn"));
    expect(TERMINAL_THEME.blue).toBe(declared(tokens, "--kd-working"));
    expect(TERMINAL_THEME.brightRed).toBe(declared(tokens, "--kd-err-strong"));
    expect(TERMINAL_THEME.brightGreen).toBe(declared(tokens, "--kd-ok-strong"));
    expect(TERMINAL_THEME.brightYellow).toBe(declared(tokens, "--kd-warn-strong"));
    // The rest of the chrome's side of the terminal: the block cursor's ink
    // is the tile it sits on, the ends of the ANSI ladder are the seam and
    // the text, and a selection is the working hue over the tile.
    expect(TERMINAL_THEME.cursorAccent).toBe(declared(tokens, "--kd-tile"));
    expect(TERMINAL_THEME.black).toBe(declared(tokens, "--kd-seam"));
    expect(TERMINAL_THEME.brightWhite).toBe(declared(tokens, "--kd-text"));
    const working = declared(tokens, "--kd-working");
    const rgb = [1, 3, 5].map((i) => parseInt(working.slice(i, i + 2), 16)).join(", ");
    expect(TERMINAL_THEME.selectionBackground).toBe(`rgba(${rgb}, 0.32)`);
    // The foreground is the terminal's own ink — between --kd-text and
    // --kd-text-2, the brightness long output reads comfortably at — and
    // must stay between them.
    const fg = lightness(TERMINAL_THEME.foreground!);
    expect(fg).toBeLessThan(lightness(declared(tokens, "--kd-text")));
    expect(fg).toBeGreaterThan(lightness(declared(tokens, "--kd-text-2")));
  });

  it("open the native window on the canvas, so launch shows no second colour", () => {
    const conf = JSON.parse(readFileSync(join(STYLES_DIR, "..", "..", "src-tauri", "tauri.conf.json"), "utf8"));
    expect(conf.app.windows[0].backgroundColor).toBe(declared(tokens, "--kd-canvas"));
    // And the page painted before the stylesheet loads — the splash — or
    // launch flashes a second colour between the window and the app.
    const page = readFileSync(join(STYLES_DIR, "..", "..", "index.html"), "utf8");
    const backgrounds = [...page.matchAll(/background:\s*(#[0-9a-fA-F]{6})/g)].map(([, hex]) => hex);
    expect(backgrounds.length).toBeGreaterThan(0);
    expect(new Set(backgrounds)).toEqual(new Set([declared(tokens, "--kd-canvas")]));
  });

  it("float the dock and every dialog above the tiles, never below them", () => {
    // One old hex painted both the structural strip (bar, rail) and the
    // floating layers; the tiers split them, and this keeps them split.
    const surface = (file: string, selector: string) =>
      ruleBody(readStyles(file), selector)["background-color"];
    expect(surface("dock.css", ".dock")).toBe("var(--kd-float)");
    expect(surface("form.css", ".form")).toBe("var(--kd-float)");
    expect(surface("confirm.css", ".confirm")).toBe("var(--kd-float)");
    expect(surface("peek.css", ".peek__panel")).toBe("var(--kd-float)");
  });

  it("hold the chart's surface constant to the canvas it is drawn on", () => {
    expect(chart.CHART_SURFACE).toBe(declared(tokens, "--kd-canvas"));
  });

  it("draw the chart's chrome in the chrome's tokens", () => {
    const pairs: [string, string][] = [
      [chart.CHART_GRID, "--kd-hover"],
      [chart.CHART_AXIS, "--kd-seam"],
      [chart.CHART_TICK_INK, "--kd-text-4"],
      [chart.CHART_LEGEND_INK, "--kd-text-3"],
      [chart.CHART_ITEM_INK, "--kd-text-2"],
      [chart.CHART_LABEL_INK, "--kd-text-4"],
      [chart.CHART_TOOLTIP_BG, "--kd-float"],
      [chart.CHART_TOOLTIP_BORDER, "--kd-seam"],
    ];
    for (const [value, token] of pairs) expect(value).toBe(declared(tokens, token));
  });

  it("paint a status dot in its hue, never in the tint meant for a surface", () => {
    // The -tint and -fill rungs are the status hues pre-blended into a
    // surface — backgrounds for a banner or a pill. On a 6px dot they read
    // as a hole: the sweep once mapped four dots onto them, and a warning
    // dot on the float became invisible.
    const sheets = allSheets();
    const offenders: string[] = [];
    for (const [file, css] of sheets) {
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/dot|__dirty/.test(selector)) continue;
        if (/background(-color)?:\s*var\(--kd-\w+-(tint|fill)\)/.test(body))
          offenders.push(`${file}: ${selector.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("cast ONE shadow from everything that floats, and no other black shadow", () => {
    // Tiles cast nothing; a dialog, the dock, a popover, a menu and a
    // tooltip all sit at the same height above them, so they share one
    // shadow — twelve hand-tuned ones made twelve heights.
    const floating: [string, string][] = [
      ["form.css", ".form"],
      ["confirm.css", ".confirm"],
      ["dock.css", ".dock--floating"],
      ["peek.css", ".peek__panel"],
      ["usage.css", ".usage-panel"],
      ["notifications.css", ".bell__panel"],
      ["form.css", ".dropdown__menu"],
      ["tooltip.css", ".kd-tip"],
      ["minimize.css", ".minimized-overflow"],
      ["minimize.css", ".minimized-tooltip"],
      ["tasks.css", ".tasks__detail"],
    ];
    for (const [file, selector] of floating) {
      expect(ruleBody(readStyles(file), selector)["box-shadow"], selector).toBe("var(--kd-shadow-float)");
    }
    // A drop shadow in black anywhere else is a height of its own. The
    // pane being dragged is the one thing lifted higher than a dialog.
    const stray = allSheets()
      .flatMap(([file, css]) =>
        [...css.matchAll(/([^{}]+)\{[^{}]*box-shadow:[^;]*(?:rgba?\(0,? 0,? 0|#000\b|\bblack\b)[^;]*;/g)].map(
          ([, selector]) => `${file}: ${selector.trim()}`,
        ),
      )
      .filter((hit) => !hit.includes(".pane-drag-ghost"));
    expect(stray).toEqual([]);
  });

  it("round every control and every tile from its token", () => {
    // Shape by role: a control is one radius wherever it is drawn, a tile
    // another. A literal beside its own token is a copy waiting to drift.
    const radius = (file: string, selector: string) =>
      ruleBody(readStyles(file), selector)["border-radius"];
    // Every radius the shared buttons declare is the control's.
    for (const file of ["button.css", "buttons.css"]) {
      const radii = [...readStyles(file).matchAll(/border-radius:\s*([^;]+);/g)].map(([, v]) => v);
      expect(radii.length, file).toBeGreaterThan(0);
      expect(new Set(radii), file).toEqual(new Set(["var(--kd-radius-control)"]));
    }
    expect(radius("history.css", ".history__fork")).toBe("var(--kd-radius-control)");
    expect(radius("pane.css", ".pane")).toBe("var(--kd-radius-tile)");
  });

  it("define every token a sheet asks for", () => {
    // An undefined var() falls back to nothing, silently: a colour becomes
    // transparent, a size the inherited one.
    // A sheet may declare a local one of its own (a rule's parameter, like
    // a menu's slide-in offset); anything else must come from tokens.css.
    const declaredNames = new Set(
      [tokens, ...allSheets().map(([, css]) => css)].flatMap((css) =>
        [...css.matchAll(/(--kd-[\w-]+)\s*:/g)].map(([, name]) => name),
      ),
    );
    const undefinedRefs = allSheets().flatMap(([file, css]) =>
      [...css.matchAll(/var\((--kd-[\w-]+)/g)]
        .map(([, name]) => name)
        .filter((name) => !declaredNames.has(name))
        .map((name) => `${file}: ${name}`),
    );
    expect(undefinedRefs).toEqual([]);
  });

  it("load every stylesheet in the folder — one left out of index.css styles nothing", () => {
    // The team cards' sheet came back to the tree without its import once,
    // and the cards rendered bare.
    const imported = new Set(
      [...readStyles("index.css").matchAll(/@import\s+"\.\/([^"]+)"/g)].map(([, f]) => f),
    );
    const sheets = readdirSync(STYLES_DIR).filter((f) => f.endsWith(".css") && f !== "index.css");
    expect(sheets.filter((f) => !imported.has(f))).toEqual([]);
  });

  it("start no animation whose keyframes are gone", () => {
    const keyframes = new Set(
      allSheets().flatMap(([, css]) => [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map(([, n]) => n)),
    );
    const missing = allSheets().flatMap(([file, css]) =>
      [...css.matchAll(/animation(?:-name)?:\s*([\w-]+)/g)]
        .map(([, name]) => name)
        .filter((name) => name !== "none" && !keyframes.has(name))
        .map((name) => `${file}: ${name}`),
    );
    expect(missing).toEqual([]);
  });

  it("set every size in the chrome from the type scale, and draw the chart's text on it", () => {
    // Three steps, named by use and far enough apart to read as three. A
    // rendered Markdown document keeps its own heading scale; nothing else
    // may bring a size of its own.
    const steps = Object.fromEntries(
      ["small", "normal", "title"].map((n) => [n, declared(tokens, `--kd-font-${n}`)]),
    );
    expect(steps).toEqual({ small: "11px", normal: "13px", title: "16px" });
    // Neighbouring steps at least 2px apart — a 1px step is one nobody sees.
    const px = Object.values(steps).map((v) => parseFloat(v));
    for (let i = 1; i < px.length; i++) expect(px[i] - px[i - 1]).toBeGreaterThanOrEqual(2);
    const literal = allSheets()
      .filter(([file]) => !file.endsWith("markdown.css"))
      .flatMap(([file, css]) =>
        [...css.matchAll(/font-size:\s*([^;]+);/g)]
          .map(([, v]) => v.trim())
          .filter((v) => !/^var\(--kd-font-(small|normal|title)\)$/.test(v))
          .map((v) => `${file}: ${v}`),
      );
    expect(literal).toEqual([]);
    expect(`${chart.CHART_TEXT_SIZE}px`).toBe(steps.small);
    expect(`${TERMINAL_FONT_SIZE}px`).toBe(steps.normal);
    expect(`${TERMINAL_LOG_FONT_SIZE}px`).toBe(steps.small);
  });

  it("round everything from a radius step — circles and pills aside", () => {
    const literal = allSheets().flatMap(([file, css]) =>
      [...css.matchAll(/border-radius:\s*([^;]+);/g)]
        .flatMap(([, v]) => v.trim().split(/\s+(?![^(]*\))/))
        .filter((v) => !/^(var\(--kd-radius-(mark|control|pop|tile|dialog)\)|50%|999px|0|inherit)$/.test(v))
        .map((v) => `${file}: ${v}`),
    );
    expect(literal).toEqual([]);
  });

  it("fill a chosen option — a choice must not look like a hover", () => {
    const form = readStyles("form.css");
    const rest = ruleBody(form, ".form__type");
    const hover = ruleBody(form, ".form__type:hover:not(:disabled)");
    const active = ruleBody(form, ".form__type--active,\n.form__type--active:hover:not(:disabled)");
    expect(active["background-color"]).not.toBe(rest["background-color"]);
    expect(active["background-color"]).not.toBe(hover["background-color"] ?? rest["background-color"]);
    expect(active.color).not.toBe(hover.color);
  });

  it("mark a selected row brighter than a hovered one, never darker", () => {
    // The colour sweep once gave selected rows the tile — a step BELOW the
    // hover — so the chosen item was the dimmest in its list.
    const rows: [string, string][] = [
      ["settings.css", ".settings__nav-item--active"],
      ["library.css", ".library__item--active"],
      ["form.css", ".form__session--active"],
      ["settings.css", ".roles__row--active"],
    ];
    for (const [file, selector] of rows) {
      expect(ruleBody(readStyles(file), selector)["background-color"], selector).toBe("var(--kd-selected)");
    }
    expect(lightness(declared(tokens, "--kd-selected"))).toBeGreaterThan(lightness(declared(tokens, "--kd-hover")));
  });

  it("rim a minimized chip in every state, and pulse every live one in its own rhythm", () => {
    // The tray holds the panes nobody is watching; its chip's rim is how a
    // glance reads them — working and done as much as waiting and failed.
    const status = readStyles("status.css");
    for (const state of ["working", "done", "waiting", "failed"]) {
      const rim = ruleBody(status, `.minimized.minimized--frame-${state}`).border;
      expect(rim, state).toBe(`1px solid var(--status-${state})`);
    }
    // Rhythm is the state's identity, on the tile and the chip alike:
    // failed 1s, waiting 2s, working 1.6s; done holds still.
    const rhythm: Record<string, string> = { failed: " 1s ", waiting: " 2s ", working: " 1.6s " };
    for (const [state, pace] of Object.entries(rhythm)) {
      for (const selector of [`.pane--frame-${state}`, `.minimized.minimized--frame-${state}`]) {
        expect(ruleBody(status, selector).animation ?? "", selector).toContain(pace);
      }
    }
    expect(ruleBody(status, ".pane--frame-done").animation).toBeUndefined();
  });
});
