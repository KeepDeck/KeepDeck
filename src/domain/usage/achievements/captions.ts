import { formatTokens, formatUsd } from "../format";
import type { AchievementMetric } from "./catalog";

/**
 * Captions: one spec per metric, exhaustive by construction. The Record
 * type forces every new metric to bring its full caption set — a ladder
 * addition that forgets one fails to compile instead of silently rendering
 * "3 / 500" where "$3.42 / $500" was meant.
 */

interface MetricSpec {
  /** "10M tokens all-time" — the requirement line under a badge title;
   * shared with the unlock notification body. */
  requirement(threshold: number): string;
  /** "5.5B / 10B" — the compact progress caption on an in-progress goal. */
  progress(progress: number, threshold: number): string;
  /** "5,471,316,706 of 10,000,000,000 — 54%" — the tooltip's exact line. */
  exact(progress: number, threshold: number): string;
}

/** Captions only ever need the static half of a tier plus its live value —
 * structural shapes, so this module never depends on the dated view types
 * their producer (ladders.ts) owns. */
export interface AchievementTierRef {
  metric: AchievementMetric;
  threshold: number;
}
export interface AchievementProgressRef extends AchievementTierRef {
  progress: number;
}

/** What a tier is CALLED — shared, because two surfaces name the same award
 * and they may not disagree. */
export interface AchievementNameRef {
  title: string;
  /** Which time a re-earned top was won; absent below it. */
  repeat?: number;
}

/**
 * An ORDINAL, never a multiplier: "×2" states twice the amount, and the
 * second winning of a top sits at TEN times the first.
 *
 * The table stops where the catalog does, plus one step of slack; anything
 * beyond falls back to a plain number rather than inventing numerals nobody
 * asked for.
 */
const REPEAT_NUMERALS: readonly string[] = ["II", "III", "IV"];

/**
 * The one name for an award, used by the gallery card, its tooltip and the
 * unlock notification alike.
 *
 * Re-earned tops deliberately SHARE a title with the tier below them — the
 * point of a repeat is that it is the same trophy won again — so the
 * ordinal is the only thing telling them apart. While it lived in the view,
 * the banner said "Token Tycoon" for all three winnings and the card said
 * "Token Tycoon III": one award, two names.
 */
export function achievementDisplayTitle(item: AchievementNameRef): string {
  if (item.repeat === undefined || item.repeat < 2) return item.title;
  const numeral = REPEAT_NUMERALS[item.repeat - 2];
  return `${item.title} ${numeral ?? item.repeat}`;
}

/** THE progress-fraction rule: how far along a tier is, as a percentage
 * capped at 100. The gallery's bar width and the tooltip's floored percent
 * both derive from this one function — capping, scaling or re-basing the
 * rule happens here or nowhere. */
export function achievementPercent(
  item: Pick<AchievementProgressRef, "threshold" | "progress">,
): number {
  return Math.min(100, (item.progress / item.threshold) * 100);
}

const pctOf = (progress: number, threshold: number) =>
  Math.floor(achievementPercent({ progress, threshold }));
const exactInt = (value: number) => Math.floor(value).toLocaleString("en-US");

const tokensSpec = (requirement: (t: string) => string): MetricSpec => ({
  requirement: (t) => requirement(formatTokens(t)),
  progress: (p, t) => `${formatTokens(p)} / ${formatTokens(t)}`,
  exact: (p, t) => `${exactInt(p)} of ${exactInt(t)} — ${pctOf(p, t)}%`,
});

const countSpec = (requirement: (t: number) => string): MetricSpec => ({
  requirement,
  progress: (p, t) => `${Math.floor(p)} / ${t}`,
  exact: (p, t) => `${exactInt(p)} of ${exactInt(t)} — ${pctOf(p, t)}%`,
});

const moneySpec = (requirement: (t: string) => string): MetricSpec => ({
  requirement: (t) => requirement(t.toLocaleString("en-US")),
  progress: (p, t) => `${formatUsd(p)} / $${t.toLocaleString("en-US")}`,
  exact: (p, t) =>
    `${formatUsd(p)} of $${t.toLocaleString("en-US")} — ${pctOf(p, t)}%`,
});

const METRIC_SPECS: Record<AchievementMetric, MetricSpec> = {
  tokens: tokensSpec((t) => `${t} tokens all-time`),
  outputTokens: tokensSpec((t) => `${t} output tokens all-time`),
  cacheTokens: tokensSpec((t) => `${t} cache-read tokens all-time`),
  sessions: countSpec((t) => `${t} session${t === 1 ? "" : "s"} all-time`),
  spendUsd: moneySpec((t) => `$${t} provider-reported spend`),
  dayTokens: tokensSpec((t) => `${t} tokens in one day`),
  daySessions: countSpec((t) => `${t} sessions in one day`),
  dayProviders: countSpec((t) => `${t} providers in one day`),
  sessionTokens: tokensSpec((t) => `${t} tokens in one session`),
  sessionTurns: countSpec((t) => `${t} usage updates in one session`),
  sessionHours: countSpec((t) => `a session ${t} hours long`),
  sessionSpendUsd: moneySpec((t) => `$${t} in one session`),
  streakDays: countSpec((t) => `${t} active days in a row`),
  providers: countSpec((t) => `${t} providers used`),
  models: countSpec((t) => `${t} models used`),
  workspaces: countSpec((t) => `${t} workspaces used`),
};

/** The requirement line under a badge title. Accepts anything carrying a
 * metric and threshold — a full tier or a bare catalog entry. */
export function achievementRequirement(item: AchievementTierRef): string {
  return METRIC_SPECS[item.metric].requirement(item.threshold);
}

/** The compact progress caption on an in-progress goal. */
export function achievementProgress(item: AchievementProgressRef): string {
  return METRIC_SPECS[item.metric].progress(item.progress, item.threshold);
}

/** The exact-numbers line behind the compact caption (hover tooltip). */
export function achievementExact(item: AchievementProgressRef): string {
  return METRIC_SPECS[item.metric].exact(item.progress, item.threshold);
}
