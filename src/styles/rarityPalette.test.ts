import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SPARE_SLOTS } from "../domain/usage/chartPalette";
import { FALLBACK_GOLD } from "../components/stats/AchievementEmbers";

/**
 * The rarity palette's answer has to be the same in three languages, and a
 * comment saying "keep in sync" is not a mechanism. The stylesheet is the
 * source of truth; this reads it and holds the two copies to it.
 *
 * The copies are not carelessness. A canvas gradient cannot say `var()`, and
 * chartPalette is JS that cannot import CSS — so each one exists for a
 * reason. What was missing is anything that fails when they drift.
 */
const STYLES_DIR = "src/styles";
const read = (file: string) => readFileSync(join(STYLES_DIR, file), "utf8");

function customProperty(css: string, name: string): string {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
  if (!match) throw new Error(`${name} is not declared`);
  return match[1].trim();
}

describe("the rarity palette", () => {
  const achievements = read("stats-achievements.css");
  const base = read("base.css");

  it("draws four of its five levels from tokens the app already has", () => {
    expect(customProperty(achievements, "--rarity-uncommon")).toBe("var(--kd-ok)");
    expect(customProperty(achievements, "--rarity-rare")).toBe("var(--kd-info)");
    expect(customProperty(achievements, "--rarity-legendary")).toBe(
      "var(--kd-warn)",
    );
  });

  it("keeps epic on the same violet chartPalette spends", () => {
    // Written out rather than shared, because the two live in different
    // languages and neither can import the other — the same reason
    // chartPalette itself writes out --kd-bg.
    expect(customProperty(achievements, "--rarity-epic")).toBe(SPARE_SLOTS[2]);
  });

  it("keeps the ember canvas's fallback gold on --kd-warn", () => {
    // The canvas reads the live custom property at mount; this literal is
    // only the answer for a DOM that computes no styles. It still has to be
    // the RIGHT answer, or a stylesheet-less render burns a different colour.
    const warn = customProperty(base, "--kd-warn");
    const hex = `#${FALLBACK_GOLD.map((channel) =>
      channel.toString(16).padStart(2, "0"),
    ).join("")}`;
    expect(hex).toBe(warn.toLowerCase());
  });
});
