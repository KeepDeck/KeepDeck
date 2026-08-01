/** Decimal-currency arithmetic on binary floats — THE one rounding rule for
 * provider cost. Provider totals are decimal currency but arrive as IEEE
 * doubles; every writer and aggregator that touches money rounds through
 * here, so two surfaces can never disagree by a float ulp. */

export function roundMoney(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}

export function addMoney(left: number, right: number): number {
  return roundMoney(left + right);
}
