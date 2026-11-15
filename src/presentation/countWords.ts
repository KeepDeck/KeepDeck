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
