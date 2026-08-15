// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// React 19 requires this flag for act() outside a test-framework integration.
(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The section talks to the real catalog manager over a mocked disk — the
// tests cover the whole loop: control → manager → domain → re-render.
const rolesIpc = vi.hoisted(() => {
  const disk = new Map<string, string>();
  return {
    disk,
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
});
vi.mock("../../ipc/roles", () => rolesIpc);

import {
  initRoleCatalog,
  resetRoleCatalogManager,
  saveStoredRole,
} from "../../app/roleCatalogManager";
import { roleById } from "../../domain/mail";
import { TeamRolesSection } from "./TeamRolesSection";

let root: Root;

beforeEach(() => {
  rolesIpc.disk.clear();
  rolesIpc.saveRoleFile.mockClear();
  rolesIpc.deleteRoleFile.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  // The manager under test configured the DOMAIN's catalog — put the
  // built-ins back so nothing leaks into the next suite.
  resetRoleCatalogManager();
});

async function mount(): Promise<void> {
  resetRoleCatalogManager();
  await initRoleCatalog();
  document.body.innerHTML = "<div id='host'></div>";
  root = createRoot(document.getElementById("host")!);
  await act(async () => root.render(createElement(TeamRolesSection)));
}

const button = (text: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === text,
  )!;

const row = (contains: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>(".roles__row")).find(
    (candidate) => candidate.textContent!.includes(contains),
  )!;

const field = (label: string) =>
  document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
    `[aria-label="${label}"]`,
  )!;

/** Type into a controlled React input/textarea: set via the native setter
 * (bypassing React's value tracker) and fire a bubbling `input` event. */
function type(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    set.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const click = (el: HTMLElement) => act(async () => el.click());

describe("TeamRolesSection", () => {
  it("lists the built-ins, and a stored role of the user's own as yours", async () => {
    rolesIpc.disk.set(
      "docs",
      JSON.stringify({ label: "Docs", summary: "writes it down", charter: ["You DOCUMENT."] }),
    );
    await mount();
    expect(row("Lead")).toBeDefined();
    expect(row("Peer")).toBeDefined();
    expect(row("Docs").textContent).toContain("yours");
  });

  it("edits a built-in's texts through its file, and reset deletes the file", async () => {
    await mount();
    await click(row("Lead"));
    type(field("Role label") as HTMLInputElement, "Architect");
    await click(button("Save"));
    // The record landed on disk and the catalog re-read it: the row now
    // carries the new label and the provenance note.
    expect(rolesIpc.disk.has("lead")).toBe(true);
    expect(row("Architect").textContent).toContain("edited");

    await click(row("Architect"));
    await click(button("Reset to default"));
    expect(rolesIpc.disk.has("lead")).toBe(false);
    expect(row("Lead").textContent).not.toContain("edited");
  });

  it("refuses a creation the domain grammar refuses, and writes nothing", async () => {
    await mount();
    await click(button("+ Add role"));
    type(field("Role id") as HTMLInputElement, "impl-2");
    type(field("Role label") as HTMLInputElement, "Impostor");
    type(field("Role summary") as HTMLInputElement, "pretends");
    type(field("Role charter"), "You pretend.");
    await click(button("Save"));
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      "numbered",
    );
    expect(rolesIpc.saveRoleFile).not.toHaveBeenCalled();
  });

  it("lets a late-landing catalog re-seed an untouched editor", async () => {
    await mount();
    await click(row("Lead"));
    expect((field("Role label") as HTMLInputElement).value).toBe("Lead");
    // The stored override lands AFTER the editor opened — a slow boot read
    // resolving, another surface saving. Untouched, the draft follows it:
    // saving the pre-load seed would overwrite texts the user never saw.
    rolesIpc.disk.set(
      "lead",
      JSON.stringify({ label: "Captain", summary: "owns it", charter: ["You COMMAND."] }),
    );
    await act(async () => {
      await saveStoredRole("docs", {
        label: "Docs",
        summary: "writes",
        charter: ["You DOCUMENT."],
      });
    });
    expect((field("Role label") as HTMLInputElement).value).toBe("Captain");
    // Typed-into, the draft is the user's and stays through the next change.
    type(field("Role label") as HTMLInputElement, "Chief");
    await act(async () => {
      await saveStoredRole("buddy", {
        label: "Buddy",
        summary: "helps",
        charter: ["You HELP."],
      });
    });
    expect((field("Role label") as HTMLInputElement).value).toBe("Chief");
  });

  it("shows an orphan deletion's failure even with no editor open", async () => {
    // The error used to render only inside the editor — an orphan is
    // deleted while browsing, and a refusal set into hidden state reads as
    // a button that did nothing.
    rolesIpc.disk.set("broken", "{oops");
    await mount();
    rolesIpc.deleteRoleFile.mockImplementationOnce(async () => {
      throw new Error("disk said no");
    });
    await click(button("Delete"));
    expect(document.querySelector('[role="alert"]')!.textContent).toContain(
      "disk said no",
    );
  });

  it("keeps an unrelated open draft when an orphan is deleted", async () => {
    rolesIpc.disk.set("broken", "{oops");
    await mount();
    await click(row("Peer"));
    type(field("Role label") as HTMLInputElement, "Buddy");
    await click(button("Delete"));
    expect(rolesIpc.disk.has("broken")).toBe(false);
    expect((field("Role label") as HTMLInputElement).value).toBe("Buddy");
  });

  it("freezes a custom role's standing and repeatability after creation", async () => {
    // The team rules run on these, and live teams were planned against
    // them — flipped underneath, a led team's member would be refused as
    // "flat" while its briefing still names the lead.
    rolesIpc.disk.set(
      "docs",
      JSON.stringify({ label: "Docs", summary: "writes it down", charter: ["You DOCUMENT."] }),
    );
    await mount();
    await click(row("Docs"));
    expect(button("A peer — flat teams only").disabled).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>(".roles__repeatable input")!
        .disabled,
    ).toBe(true);
  });

  it("creates a role of the user's own that the whole catalog then knows", async () => {
    await mount();
    await click(button("+ Add role"));
    type(field("Role id") as HTMLInputElement, "docs");
    type(field("Role label") as HTMLInputElement, "Docs");
    type(field("Role summary") as HTMLInputElement, "writes it down");
    type(field("Role charter"), "You DOCUMENT.\nYou do not edit code.");
    await click(button("Save"));
    // Not just rendered — the DOMAIN sees it, which is what the dialog's
    // picker and the briefings read.
    expect(roleById("docs")).toBeDefined();
    expect(roleById("docs")!.charter).toHaveLength(2);
    expect(row("Docs").textContent).toContain("yours");
  });
});
