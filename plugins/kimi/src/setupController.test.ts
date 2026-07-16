import { describe, expect, it, vi } from "vitest";
import type { PluginLogger } from "@keepdeck/plugin-api";
import { COMPANION_ID, COMPANION_VERSION } from "./companion";
import type { KimiCompanionManager } from "./manager";
import {
  createKimiSetupController,
  stateFromInstallation,
} from "./setupController";

function harness(
  inspectResults: Array<
    Awaited<ReturnType<KimiCompanionManager["inspect"]>>
  >,
) {
  const inspect = vi.fn(async () => inspectResults.shift() ?? null);
  const manager: KimiCompanionManager = {
    inspect,
    configure: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  const log: PluginLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return {
    controller: createKimiSetupController(manager, "/App/reporter", log),
    manager,
    inspect,
    log,
  };
}

describe("Kimi setup state", () => {
  it("derives explicit states from Kimi's real installation", () => {
    expect(stateFromInstallation(null)).toEqual({
      kind: "not-configured",
      operation: null,
    });
    expect(
      stateFromInstallation({
        version: COMPANION_VERSION,
        enabled: true,
        healthy: true,
      }),
    ).toEqual({
      kind: "configured",
      operation: null,
      version: COMPANION_VERSION,
    });
    expect(
      stateFromInstallation({
        version: COMPANION_VERSION,
        enabled: false,
        healthy: true,
      }),
    ).toMatchObject({ kind: "needs-attention", reason: "disabled" });
    expect(
      stateFromInstallation({
        version: "0.9.0",
        enabled: true,
        healthy: true,
      }),
    ).toMatchObject({ kind: "needs-attention", reason: "outdated" });
  });

  it("re-checks Kimi after configure and remove", async () => {
    const healthy = {
      version: COMPANION_VERSION,
      enabled: true,
      healthy: true,
    };
    const configured = harness([healthy]);
    await configured.controller.configure();
    expect(configured.manager.configure).toHaveBeenCalledWith("/App/reporter");
    expect(configured.inspect).toHaveBeenCalledWith(COMPANION_ID);
    expect(configured.controller.snapshot()).toMatchObject({
      kind: "configured",
    });

    const removed = harness([null]);
    await removed.controller.remove();
    expect(removed.manager.remove).toHaveBeenCalledWith(COMPANION_ID);
    expect(removed.controller.snapshot()).toMatchObject({
      kind: "not-configured",
    });
  });

  it("exposes check failures without pretending setup is absent", async () => {
    const { controller, manager, log } = harness([]);
    vi.mocked(manager.inspect).mockRejectedValueOnce(new Error("kimi not found"));

    await expect(controller.check()).resolves.toEqual({
      kind: "error",
      operation: null,
      message: "kimi not found",
    });
    expect(log.warn).toHaveBeenCalledWith(
      "Kimi setup check failed: kimi not found",
    );
  });
});
