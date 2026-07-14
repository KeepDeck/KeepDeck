import { describe, expect, it, vi } from "vitest";
import { buildGuestContext } from "./context";
import { fakeManifest } from "./fakeHost";
import { GuestRpc } from "./rpc";

/**
 * Direct tests of the guest context builder — the parts worth pinning without
 * standing up the whole channel. Chief among them: an external dock tab MUST be
 * the iframe variant, and the guest must reject a Component synchronously (a
 * plugin author sees the mistake at the `register` call, not as a silent no-op
 * or a broken frame later).
 */

/** A GuestRpc over a port whose `postMessage` is a no-op — the synchronous
 * guard under test fires before anything would be sent. */
function silentRpc(): GuestRpc {
  const port = { postMessage() {}, onmessage: null } as unknown as MessagePort;
  return new GuestRpc(port);
}

describe("buildGuestContext dock tabs", () => {
  it("throws synchronously when a dock tab carries a React Component", () => {
    const { ctx } = buildGuestContext(silentRpc(), fakeManifest());
    expect(() =>
      ctx.ui.registerDockTab({ id: "t", label: "T", Component: () => null }),
    ).toThrow(/iframe/);
  });

  it("accepts the iframe dock-tab variant", () => {
    const { ctx } = buildGuestContext(silentRpc(), fakeManifest());
    const disposable = ctx.ui.registerDockTab({
      id: "t",
      label: "T",
      iframe: "ui/panel.html",
    });
    expect(typeof disposable.dispose).toBe("function");
  });

  it("carries the host-provided manifest through as ctx.manifest", () => {
    const manifest = fakeManifest("dev.custom");
    const { ctx } = buildGuestContext(silentRpc(), manifest);
    expect(ctx.manifest).toBe(manifest);
  });
});

describe("registration outcomes fail loud", () => {
  it("a refused registration rejects registrationsSettled", async () => {
    // The host answers ok:false (an undeclared contribution, a gate
    // violation) — activation must FAIL, not show active with the
    // contribution silently missing.
    const rpc = {
      call: vi.fn((path: string) =>
        path === "agents.register"
          ? Promise.reject(new Error('agents "codex" not declared'))
          : Promise.resolve(undefined),
      ),
    } as unknown as GuestRpc;
    const bundle = buildGuestContext(rpc, fakeManifest());
    bundle.ctx.agents.register({
      id: "codex",
      label: "Codex",
      detect: { bin: "codex" },
      hooks: {},
    });
    await expect(bundle.registrationsSettled()).rejects.toThrow("not declared");
  });

  it("accepted registrations settle clean", async () => {
    const rpc = {
      call: vi.fn(() => Promise.resolve(undefined)),
    } as unknown as GuestRpc;
    const bundle = buildGuestContext(rpc, fakeManifest());
    bundle.ctx.settings.registerSection({ label: "S", fields: [] });
    await expect(bundle.registrationsSettled()).resolves.toBeUndefined();
  });
});

describe("agent registration payload", () => {
  it("carries the icon as data; hooks cross as names only", async () => {
    const call = vi.fn((..._args: unknown[]) => Promise.resolve(undefined));
    const rpc = { call } as unknown as GuestRpc;
    const bundle = buildGuestContext(rpc, fakeManifest());
    const icon = {
      viewBox: "0 0 24 24",
      paths: [{ d: "M0 0h24v24H0z", color: "#D97757" }],
    };
    bundle.ctx.agents.register({
      id: "codex",
      label: "Codex",
      icon,
      detect: { bin: "codex" },
      hooks: { "spawn.plan": () => {} },
    });
    await bundle.registrationsSettled();
    const register = call.mock.calls.find(
      ([path]) => path === "agents.register",
    );
    expect(register).toBeDefined();
    const [, payload] = register![1] as [number, Record<string, unknown>];
    expect(payload.icon).toEqual(icon);
    expect(payload.hookNames).toEqual(["spawn.plan"]);
    expect(payload).not.toHaveProperty("hooks");
  });
});
