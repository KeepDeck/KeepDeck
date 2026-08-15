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

  it("keeps the built-ins when the load fails, says so, and refuses to save", async () => {
    // Never install an empty lie — and never let one be SAVED: with the
    // records unknown, a save would overwrite files this session never
    // saw, and the fresh-install look of the UI would invite exactly that.
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
    expect(manager.get().problems[0]).toContain("could not be read");
    await expect(
      manager.save("docs", { label: "x", summary: "y", charter: ["z"] }),
    ).rejects.toThrow(/Restart/);
    await expect(manager.remove("docs")).rejects.toThrow(/Restart/);
    expect(ports.saveRoleFile).not.toHaveBeenCalled();
    expect(ports.deleteRoleFile).not.toHaveBeenCalled();
  });

  it("treats the boot load as a baseline and only a real difference as a change", async () => {
    // Fired on load, the change feed re-briefed every teamed pane on every
    // app start — the boot install is what the panes were last briefed
    // from, not news.
    const { manager } = host({ docs: DOCS });
    const changed = vi.fn();
    manager.onCatalogChanged(changed);
    await manager.init();
    expect(changed).not.toHaveBeenCalled();
    await manager.save("buddy", {
      label: "Buddy",
      summary: "stands beside you",
      charter: ["You HELP."],
    });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("keeps a save that landed when only the re-read fails", async () => {
    // The write is durable; the directory read is not. Reporting the save
    // as failed — while the domain kept briefing from the old texts — was
    // both halves of the lie.
    const { disk, ports, manager } = host();
    await manager.init();
    (ports.fetchRoleFiles as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        throw new Error("transient EIO");
      },
    );
    await manager.save("docs", {
      label: "Docs",
      summary: "writes it down",
      charter: ["You DOCUMENT."],
    });
    expect(disk.has("docs")).toBe(true);
    expect(roleById("docs")).toBeDefined();
    expect(manager.get().storedIds.has("docs")).toBe(true);
  });

  it("lowercases stored ids so a hand-cased file still reads as the role it edits", async () => {
    const { manager } = host({ Lead: JSON.stringify({ label: "Captain", summary: "s", charter: ["c"] }) });
    await manager.init();
    expect(manager.get().storedIds.has("lead")).toBe(true);
  });

  it("re-briefs across a restart when the files changed while the app was closed", async () => {
    // The baseline outlives the process: a hand edit made between sessions
    // installs at boot as a CHANGE against what the teams were last
    // briefed with — not as a fresh baseline that would leave every
    // restored team on stale texts forever.
    let persisted: string | null = null;
    const baseline = {
      load: () => persisted,
      store: (fingerprint: string) => {
        persisted = fingerprint;
      },
    };
    const first = host({ docs: DOCS });
    await createRoleCatalogManager({ ...first.ports, baseline }).init();

    const edited = host({
      docs: JSON.stringify({
        label: "Docs v2",
        summary: "writes it down",
        charter: ["You DOCUMENT better."],
      }),
    });
    const changed = vi.fn();
    const second = createRoleCatalogManager({ ...edited.ports, baseline });
    second.onCatalogChanged(changed);
    await second.init();
    expect(changed).toHaveBeenCalledTimes(1);

    // And an UNCHANGED folder still installs as quietly as ever.
    const same = host({
      docs: JSON.stringify({
        label: "Docs v2",
        summary: "writes it down",
        charter: ["You DOCUMENT better."],
      }),
    });
    const quiet = vi.fn();
    const third = createRoleCatalogManager({ ...same.ports, baseline });
    third.onCatalogChanged(quiet);
    await third.init();
    expect(quiet).not.toHaveBeenCalled();
  });
});
