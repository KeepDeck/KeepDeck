import { describe, expect, it } from "vitest";
import { usageDelta, usageDeltaEmpty } from "./delta";

describe("usageDelta", () => {
  it("turns cumulative token and cost snapshots into deltas", () => {
    const delta = usageDelta(
      { totalTokens: { input: 150, output: 20 }, costUsd: 1.5 },
      { tokens: { input: 100, output: 5 }, costUsd: 1 },
    );
    expect(delta).toEqual({
      tokens: { input: 50, output: 15 },
      cost: { source: "provider", usd: 0.5 },
      observation: { tokens: { input: 150, output: 20 }, costUsd: 1.5 },
    });
  });

  it("treats a dropped counter as a reset and preserves absent baselines", () => {
    expect(
      usageDelta(
        { totalTokens: { input: 20 } },
        { tokens: { input: 100, output: 7 }, costUsd: 2 },
      ),
    ).toEqual({
      tokens: { input: 20 },
      cost: { source: "unavailable" },
      observation: { tokens: { input: 20, output: 7 }, costUsd: 2 },
    });
  });

  it("recognizes duplicate cumulative observations", () => {
    const delta = usageDelta(
      { totalTokens: { input: 10 }, costUsd: 1 },
      { tokens: { input: 10 }, costUsd: 1 },
    );
    expect(usageDeltaEmpty(delta)).toBe(true);
  });

  it("seeds a resumed session without backfilling lifetime usage", () => {
    expect(
      usageDelta(
        {
          totalTokens: { input: 100, output: 10 },
          costUsd: 9,
        },
        undefined,
        { baselineOnly: true },
      ),
    ).toEqual({
      tokens: {},
      cost: { source: "unavailable" },
      observation: { tokens: { input: 100, output: 10 }, costUsd: 9 },
    });
  });

  it("seeds independently arriving resumed cost and token dimensions", () => {
    const cost = usageDelta(
      { costUsd: 9 },
      undefined,
      { baselineOnly: true },
    );
    expect(cost).toEqual({
      tokens: {},
      cost: { source: "unavailable" },
      observation: { tokens: {}, costUsd: 9 },
    });

    const tokens = usageDelta(
      { totalTokens: { input: 100, output: 10 } },
      cost.observation,
      { baselineOnly: true },
    );
    expect(tokens).toEqual({
      tokens: {},
      cost: { source: "unavailable" },
      observation: {
        tokens: { input: 100, output: 10 },
        costUsd: 9,
      },
    });

    expect(
      usageDelta(
        { totalTokens: { input: 105, output: 12 }, costUsd: 9.5 },
        tokens.observation,
        { baselineOnly: true },
      ),
    ).toEqual({
      tokens: { input: 5, output: 2 },
      cost: { source: "provider", usd: 0.5 },
      observation: {
        tokens: { input: 105, output: 12 },
        costUsd: 9.5,
      },
    });
  });

  it("preserves an explicit initial provider cost of zero", () => {
    const delta = usageDelta({ costUsd: 0 });
    expect(delta).toEqual({
      tokens: {},
      cost: { source: "provider", usd: 0 },
      observation: { tokens: {}, costUsd: 0 },
    });
    expect(usageDeltaEmpty(delta)).toBe(false);
    expect(
      usageDeltaEmpty(
        usageDelta({ costUsd: 0 }, { tokens: {}, costUsd: 0 }),
      ),
    ).toBe(true);
  });
});
