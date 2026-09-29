import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as menu from "./menu";

const RUST_MENU = join(dirname(fileURLToPath(import.meta.url)), "../../src-tauri/src/menu.rs");

describe("the native menu's events", () => {
  it("are the same strings on both sides of the IPC", () => {
    // menu.rs emits, this module listens; a name that drifts on one side is
    // a hotkey that silently does nothing.
    const rust = Object.fromEntries(
      [...readFileSync(RUST_MENU, "utf8").matchAll(/pub const (\w+_EVENT): &str = "([^"]+)";/g)].map(
        ([, name, value]) => [name, value],
      ),
    );
    const ts = Object.fromEntries(Object.entries(menu).filter(([name]) => name.endsWith("_EVENT")));
    expect(Object.keys(rust).length).toBeGreaterThan(0);
    expect(ts).toEqual(rust);
  });
});
