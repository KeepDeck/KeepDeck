import { afterEach, describe, expect, it, vi } from "vitest";
import {
  builtInRoles,
  configureRoleCatalog,
  roleById,
  teamRoles,
} from "../domain/mail";
import {
  createRoleCatalogManager,
  type RoleCatalogPorts,
} from "./roleCatalogManager";

// The manager under test configures the DOMAIN's catalog slot — put the
// built-ins back so no case leaks its roles into the next.
afterEach(() => configureRoleCatalog(null));

/** An in-memory disk behind the ports, seeded per case. */
function host(initial: Record<string, string> = {}) {
  const disk = new Map(Object.entries(initial));
  const ports: RoleCatalogPorts = {
    fetchRoleFiles: vi.fn(async () =>
      [...disk].map(([id, content]) => ({ id, content })),
    ),
    saveRoleFile: vi.fn(async (id: string, content: string) => {
      disk.set(id, content);
    }),
    deleteRoleFile: vi.fn(async (id: string) => {
      disk.delete(id);
    }),
  };
  return { disk, ports, manager: createRoleCatalogManager(ports) };
}

const DOCS = JSON.stringify({
  label: "Docs",
  summary: "writes down what the team built",
  charter: ["You DOCUMENT. Write down what was built and why."],
});

describe("roleCatalogManager", () => {
  it("feeds the domain the merged catalog on init", () => {
    const { manager } = host({ docs: DOCS });
    return manager.init().then(() => {
      expect(roleById("docs")).toBeDefined();
      expect(manager.get().records.has("docs")).toBe(true);
      expect(manager.get().problems).toEqual([]);
    });
  });

  it("names a file that is not JSON, and still lists it for deletion", async () => {
    // The merge can only judge a VALUE; bytes that never became one are
    // this module's to report. The id stays listed — the editor must show
    // a broken record to offer the one thing left to do with it.
    const { manager } = host({ broken: "{oops" });
    await manager.init();
    expect(manager.get().problems[0]).toContain("broken");
    expect(manager.get().storedIds.has("broken")).toBe(true);
    expect(manager.get().records.has("broken")).toBe(false);
    expect(teamRoles()).toEqual(builtInRoles());
  });

  it("saves a record, re-reads the disk, and tells its subscribers", async () => {
    const { disk, manager } = host();
    await manager.init();
    const heard = vi.fn();
    manager.subscribe(heard);
    await manager.save(" Docs ", {
      label: "Docs",
      summary: "writes down what the team built",
      charter: ["You DOCUMENT."],
    });
    // The id lands trimmed and lowercased — it is an address — and the
    // content pretty-printed, because the file is meant to be hand-read.
    expect(disk.has("docs")).toBe(true);
    expect(disk.get("docs")).toContain("\n");
    expect(roleById("docs")).toBeDefined();
    expect(heard).toHaveBeenCalled();
  });

  it("refuses an id the domain grammar refuses, before touching the disk", async () => {
    const { manager, ports } = host();
    await manager.init();
    await expect(
      manager.save("impl-2", { label: "x", summary: "y", charter: ["z"] }),
    ).rejects.toThrow();
    expect(ports.saveRoleFile).not.toHaveBeenCalled();
  });

  it("removes a record and the catalog returns to the defaults", async () => {
    const { manager } = host({ docs: DOCS });
    await manager.init();
    expect(roleById("docs")).toBeDefined();
    await manager.remove("docs");
    expect(roleById("docs")).toBeUndefined();
    expect(teamRoles()).toEqual(builtInRoles());
  });

  it("keeps the built-ins when the load fails, and does not block the app", async () => {
    // Never install an empty lie: an unreadable folder costs the user
    // their custom roles for the session, not the teams feature.
    const ports: RoleCatalogPorts = {
      fetchRoleFiles: vi.fn(async () => {
        throw new Error("no disk today");
      }),
      saveRoleFile: vi.fn(),
      deleteRoleFile: vi.fn(),
    };
    const manager = createRoleCatalogManager(ports);
    await manager.init();
    expect(teamRoles()).toEqual(builtInRoles());
    expect(manager.get().problems).toEqual([]);
  });
});
