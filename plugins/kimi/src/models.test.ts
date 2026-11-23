import { describe, expect, it } from "vitest";
import { parseKimiConfig } from "./config";
import { createKimiModelTable, modelWindow, modelWindows } from "./models";

describe("modelWindow — one model's window, as kimi takes it", () => {
  it("is the context size the row names", () => {
    expect(modelWindow({ model: "k3", max_context_size: 1_048_576 })).toBe(1_048_576);
  });

  it("is the input limit when the row names one", () => {
    expect(modelWindow({ max_context_size: 123_456, max_input_size: 100_000 })).toBe(100_000);
  });

  it("cuts an input limit above the context down to the context", () => {
    expect(modelWindow({ max_context_size: 50_000, max_input_size: 100_000 })).toBe(50_000);
  });

  it("takes the overrides block over the row's own fields", () => {
    expect(modelWindow({ max_context_size: 123_456, overrides: { max_context_size: 50_000 } })).toBe(50_000);
    expect(modelWindow({ max_context_size: 123_456, max_input_size: 90_000, overrides: { max_input_size: 60_000 } })).toBe(60_000);
    // An overridden context cuts the row's own input limit, as kimi clamps
    // after it applies the overrides.
    expect(modelWindow({ max_context_size: 123_456, max_input_size: 100_000, overrides: { max_context_size: 50_000 } })).toBe(50_000);
  });

  it("is none for a row that names no usable size — kimi then takes its own catalogue's", () => {
    expect(modelWindow({ model: "k3" })).toBeUndefined();
    expect(modelWindow({ max_context_size: 0 })).toBeUndefined();
    expect(modelWindow({ max_context_size: "262144" })).toBeUndefined();
    expect(modelWindow({ max_context_size: 1.5 })).toBeUndefined();
  });
});

describe("modelWindows — every alias the config names", () => {
  it("reads each [models.\"<alias>\"] table by its alias", () => {
    const config = parseKimiConfig(
      [
        '[models."kimi-code/k3"]',
        'model = "k3"',
        "max_context_size = 1048576",
        "",
        '[models."kimi-code/k3-256k"]',
        'model = "k3-256k"',
        "max_context_size = 262144",
        "",
        '[models."kimi-code/catalogued"]',
        'model = "catalogued"',
      ].join("\n"),
    );
    expect([...modelWindows(config)]).toEqual([
      ["kimi-code/k3", 1_048_576],
      ["kimi-code/k3-256k", 262_144],
    ]);
  });

  it("is empty for a config with no models", () => {
    expect(modelWindows(parseKimiConfig('default_model = "x"')).size).toBe(0);
    expect(modelWindows(undefined).size).toBe(0);
  });
});

describe("the model table of one registration", () => {
  it("answers the windows of the last config it read", () => {
    const table = createKimiModelTable();
    expect(table.windowOf("kimi-code/k3")).toBeUndefined();
    table.refresh(parseKimiConfig('[models."kimi-code/k3"]\nmax_context_size = 262144\n'));
    expect(table.windowOf("kimi-code/k3")).toBe(262_144);
    table.refresh(parseKimiConfig('[models."kimi-code/k3"]\nmax_context_size = 1048576\n'));
    expect(table.windowOf("kimi-code/k3")).toBe(1_048_576);
  });

  it("keeps what it knew through a read that found no config to parse", () => {
    const table = createKimiModelTable();
    table.refresh(parseKimiConfig('[models."kimi-code/k3"]\nmax_context_size = 262144\n'));
    table.refresh(parseKimiConfig("not [toml"));
    table.refresh(undefined);
    expect(table.windowOf("kimi-code/k3")).toBe(262_144);
  });
});
