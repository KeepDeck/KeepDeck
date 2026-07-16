import { describe, expect, it, vi } from "vitest";
import type { DownloadRequest } from "@keepdeck/plugin-api";
import type { DownloadBackend } from "./downloadManager";
import { createAppRuntime } from "./runtime";

const request = (id: string): DownloadRequest => ({
  id,
  source: { url: "https://example.com/artifact" },
  target: { kind: "file", path: `${id}/artifact` },
});

function backend(): DownloadBackend {
  return {
    start: vi.fn(async () => new Promise<void>(() => {})),
    cancel: vi.fn(async () => {}),
    exists: vi.fn(async () => false),
    remove: vi.fn(async () => {}),
  };
}

describe("createAppRuntime", () => {
  it("owns an isolated dependency graph instead of a module singleton", () => {
    const firstBackend = backend();
    const secondBackend = backend();
    const first = createAppRuntime(firstBackend);
    const second = createAppRuntime(secondBackend);

    expect(first).not.toBe(second);
    expect(first.downloads).not.toBe(second.downloads);
    expect(first.plugins.pluginHost).not.toBe(second.plugins.pluginHost);
    expect(first.plugins.pluginRegistries).not.toBe(
      second.plugins.pluginRegistries,
    );
    expect(first.fileOpen).not.toBe(second.fileOpen);

    // The same active id is legal in another runtime because neither job map
    // nor backend routing leaks through module state.
    first.downloads.start(request("same-id"));
    expect(() => second.downloads.start(request("same-id"))).not.toThrow();
    expect(firstBackend.start).toHaveBeenCalledOnce();
    expect(secondBackend.start).toHaveBeenCalledOnce();
  });
});
