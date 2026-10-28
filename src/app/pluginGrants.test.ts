import { describe, expect, it, vi } from "vitest";
import type { Capability, PluginManifest } from "@keepdeck/plugin-api";
import type { PluginInstall } from "../plugins";
import { NO_PERMISSIONS, type ResolvedPermissions } from "../plugins/capabilities";
import { createPluginGrants } from "./pluginGrants";

const resolved: ResolvedPermissions = {
  env: { KIMI_CODE_BASE_URL: null },
  net: [{ allow: ["api.example"], credentials: [] }],
};

function install(capabilities: Capability[]): PluginInstall {
  const manifest: PluginManifest = {
    id: "p.agent",
    name: "p",
    version: "1.0.0",
    minApiVersion: 1,
    category: "deck",
    capabilities,
    contributes: {},
  };
  return { manifest, load: async () => ({ activate: () => {} }) };
}

const declaring = install([{ kind: "env", names: ["KIMI_CODE_BASE_URL"] }]);

function grantsWith(resolve: () => Promise<unknown>) {
  const errors: string[] = [];
  const deps = {
    resolve: vi.fn(resolve),
    forget: vi.fn(async () => {}),
    logger: () => ({ warn: vi.fn(), error: (message: string) => errors.push(message) }),
  };
  return { grants: createPluginGrants(deps), deps, errors };
}

const malformed = () => Promise.reject(new Error("ENV_VALUE_INVALID at KIMI_CODE_BASE_URL: not a URL"));

describe("plugin grants", () => {
  it("keeps what a declaration resolved to, by plugin id", async () => {
    const { grants, deps } = grantsWith(async () => resolved);
    expect(await grants.prepare(declaring, "builtin")).toBe(declaring);
    expect(deps.resolve).toHaveBeenCalledWith("p.agent", declaring.manifest.capabilities);
    expect(grants.permissionsOf("p.agent")).toEqual(resolved);
  });

  it("installs a built-in whose declaration did not resolve, with no reach, and names the variable", async () => {
    const { grants, errors } = grantsWith(malformed);
    const prepared = await grants.prepare(declaring, "builtin");
    // The same install: its agent stays in the catalog.
    expect(prepared).toBe(declaring);
    expect(grants.permissionsOf("p.agent")).toBe(NO_PERMISSIONS);
    expect(errors[0]).toContain("KIMI_CODE_BASE_URL");
    expect(errors[0]).toContain("runs without its environment and network");
  });

  it("fails an external plugin whose declaration did not resolve, by name", async () => {
    const { grants, errors } = grantsWith(malformed);
    const prepared = await grants.prepare(declaring, "external");
    await expect(prepared.load()).rejects.toThrow("KIMI_CODE_BASE_URL");
    expect(grants.resolved("p.agent")).toBeUndefined();
    expect(errors).toHaveLength(1);
  });

  it("drops the native grant of a plugin that declares nothing any more, answers unreadably, or is gone", async () => {
    const { grants, deps } = grantsWith(async () => resolved);
    await grants.prepare(declaring, "external");
    await grants.prepare(install([{ kind: "fs", scope: "workspace" }]), "external");
    expect(deps.forget).toHaveBeenCalledTimes(1);
    expect(grants.resolved("p.agent")).toBeUndefined();

    deps.resolve.mockResolvedValueOnce({ not: "a resolution" });
    await grants.prepare(declaring, "external");
    expect(deps.forget).toHaveBeenCalledTimes(2);

    deps.resolve.mockResolvedValueOnce(resolved);
    await grants.prepare(declaring, "external");
    await grants.drop("p.agent");
    expect(deps.forget).toHaveBeenCalledTimes(3);
    expect(grants.resolved("p.agent")).toBeUndefined();
  });
});
