import { vi } from "vitest";
import type { McpLibrary } from "./mcpLibrary";

/**
 * A do-nothing MCP library for suites that only pass one through — the twin
 * of `skillsLibrary.fake.ts`, for the same reason: the return type is what
 * earns its keep, so a new method on `McpLibrary` fails to compile HERE, once,
 * instead of leaving each copy of the stub to drift on its own.
 */
export function fakeMcpLibrary(): McpLibrary {
  return {
    list: vi.fn(async () => []),
    // `read` REFUSES an absent server, so an empty library's read rejects — a
    // suite that wants a draft back stubs it. Deliberately not a near-copy of
    // the real refusal, so no suite can pin a sentence production never emits.
    read: vi.fn(async () => {
      throw new Error("fake MCP library: no server");
    }),
    create: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    serversFor: vi.fn(async () => []),
  };
}
