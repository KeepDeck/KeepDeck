/**
 * How a count agrees with its words — one rule, so "1 agents" cannot be
 * written by one surface while another says "1 agent".
 */

/** The form of a word that agrees with `n`: `one` for exactly one, else
 * `many` (a noun's plural, a verb's plural form). */
export function byCount(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** A count with its noun: "1 team", "3 teams". */
export function counted(n: number, one: string, many = `${one}s`): string {
  return `${n} ${byCount(n, one, many)}`;
}

/** The largest count a corner badge spells out; past it the badge says
 * "99+" — it holds two digits, not a ledger. */
const BADGE_MAX = 99;

/** A count as a corner badge says it (the bell's unread): the number,
 * or "99+" past two digits. */
export function badgeCount(n: number): string {
  return n > BADGE_MAX ? `${BADGE_MAX}+` : String(n);
}
