import { describe, expect, it } from "vitest";
import { orderBySource, type PluginSource } from "./installed";

interface Item {
  readonly id: string;
  readonly source: PluginSource;
}

const item = (id: string, source: PluginSource): Item => ({ id, source });

describe("orderBySource", () => {
  it("puts built-ins first, external after, preserving order within each group", () => {
    const ordered = orderBySource([
      item("b2", "builtin"),
      item("e1", "external"),
      item("b1", "builtin"),
      item("e2", "external"),
    ]);
    expect(ordered.map((i) => i.id)).toEqual(["b2", "b1", "e1", "e2"]);
  });

  it("is a pure, reproducible transform — same input, same output, input untouched", () => {
    const input = [item("e1", "external"), item("b1", "builtin")];
    const first = orderBySource(input);
    const second = orderBySource(input);
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
    expect(input.map((i) => i.id)).toEqual(["e1", "b1"]);
  });

  it("handles single-group and empty inputs", () => {
    expect(orderBySource([]).length).toBe(0);
    expect(
      orderBySource([item("b1", "builtin"), item("b2", "builtin")]).map(
        (i) => i.id,
      ),
    ).toEqual(["b1", "b2"]);
  });
});
