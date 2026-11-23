import { asFiniteNumber, isJsonRecord } from "@keepdeck/plugin-api";
import type { KimiConfig } from "./config";

/**
 * The window each of kimi's models measures its context against, by the
 * alias kimi records on the wire (`usage.record.model`, e.g.
 * "kimi-code/k3.1-pro") — read from the `[models."<alias>"]` tables of
 * kimi's config.
 *
 * The wire stopped naming a window in kimi 2.6.0, when `llm.request` was
 * no longer written (and its `maxTokens` was the request's output cap, never
 * the window); the config has named it on every version.
 */

/** A count that can be a window: a whole number above zero. */
function size(value: unknown): number | undefined {
  const n = asFiniteNumber(value);
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * One model row's window, as kimi itself takes it: its `overrides` block
 * beats the row's own fields, an input limit is the window when there is
 * one, and an input limit above the context is cut to the context.
 * Undefined for a row that names no size: kimi then takes the number from
 * its own catalogue, which the plugin cannot see.
 */
export function modelWindow(row: Readonly<Record<string, unknown>>): number | undefined {
  const overrides = isJsonRecord(row.overrides) ? row.overrides : {};
  const context = size(overrides.max_context_size) ?? size(row.max_context_size);
  const input = size(overrides.max_input_size) ?? size(row.max_input_size);
  if (input === undefined) return context;
  return context === undefined ? input : Math.min(input, context);
}

/** Every alias's window the config names. */
export function modelWindows(config: KimiConfig | undefined): ReadonlyMap<string, number> {
  const windows = new Map<string, number>();
  const models = config?.models;
  if (!isJsonRecord(models)) return windows;
  for (const [alias, row] of Object.entries(models)) {
    if (!isJsonRecord(row)) continue;
    const window = modelWindow(row);
    if (window !== undefined) windows.set(alias, window);
  }
  return windows;
}

/** The table one registration of the plugin keeps: refreshed from each read
 * of the config, asked by the wire normaliser for the window of the model a
 * record names. A new window shows on a pane at its next report, not at
 * once. */
export interface KimiModelTable {
  /** Take the config's windows. A read that found no config to parse keeps
   * what was known: a cut or failed read is no news about the models. */
  refresh(config: KimiConfig | undefined): void;
  windowOf(alias: string): number | undefined;
}

export function createKimiModelTable(): KimiModelTable {
  let windows: ReadonlyMap<string, number> = new Map();
  return {
    refresh(config) {
      if (config !== undefined) windows = modelWindows(config);
    },
    windowOf: (alias) => windows.get(alias),
  };
}
