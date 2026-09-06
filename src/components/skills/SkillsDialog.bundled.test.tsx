// @vitest-environment happy-dom
// The bundled tier in the dialog: its group, its read-only panel, the unlock
// hint, and the union with a same-named user skill.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Settings } from "../../domain/settings";
import { lib, settingsState, skill, bundled, skillsDialogHost } from "./skillsDialogTestSupport";
import { row, button, buttonByTitle, input, textarea, type } from "../library/libraryTestDom";
import { SkillsDialog } from "./SkillsDialog";

describe("SkillsDialog — the bundled tier", () => {
  const host = skillsDialogHost(SkillsDialog);
  beforeEach(() => host.setup());
  afterEach(() => host.teardown());

  it("renders the Bundled group LAST with both same-name rows visible (namespaces at rest)", async () => {
    lib.skills = [
      skill("artifacts"),
      bundled("artifacts"),
    ];
    await host.mount();
    const labels = Array.from(
      document.querySelectorAll(".library__group-label"),
    ).map((el) => el.textContent);
    expect(labels).toEqual(["Global", "My project", "Bundled"]);
    // The UNION: both rows present — the user's and the shipped one.
    expect(document.querySelectorAll(".library__item")).toHaveLength(2);
  });

  it("a bundled row uses the common editor UI, read-only — no Save, no Delete", async () => {
    lib.skills = [
      bundled("artifacts"),
    ];
    await host.mount();
    await act(async () => {
      row("artifacts")!.click();
    });
    // Bundled uses the same panel markup as Global and Workspace, plus its
    // ships-with note. Read-only preserves selection/copy without write controls.
    expect(document.querySelector(".library__editor-head")).not.toBeNull();
    expect(
      document.querySelector(".library__readonly-note")?.textContent,
    ).toContain("copy any part");
    expect(document.querySelector(".library__scope")?.textContent).toBe("Bundled");
    expect(input("skill-name").readOnly).toBe(true);
    expect(document.querySelector<HTMLTextAreaElement>("#skill-description")?.readOnly).toBe(true);
    expect(textarea("skill-body").readOnly).toBe(true);
    type(input("skill-name"), "mutated");
    type(textarea("skill-body"), "mutated");
    await host.mount();
    expect(input("skill-name").value).toBe("artifacts");
    expect(textarea("skill-body").value).toContain("Body of artifacts");
    // The write machine is absent — no actions, no Save button.
    expect(document.querySelector(".library__actions")).toBeNull();
    expect(button("Save")).toBeUndefined();
    expect(button("Delete")).toBeUndefined();
  });

  it("the viewer shows the bundled row's CONTENT, not a blank shell (RL-8)", async () => {
    // The nav-click path once fell through apply() with no view branch:
    // setForm(EMPTY_FORM) — a blank name/description/body while every
    // presence pin stayed green. A viewer pin asserts the DATA.
    lib.skills = [
      {
        scope: { kind: "bundled" },
        name: "artifacts",
        content:
          "---\nname: artifacts\ndescription: Publish live pages from any pane\n---\n\nPublish body text.",
      },
    ];
    await host.mount();
    await act(async () => {
      row("artifacts")!.click();
    });
    expect(input("skill-name").value).toBe("artifacts");
    expect(
      document.querySelector<HTMLTextAreaElement>("#skill-description")?.value,
    ).toBe("Publish live pages from any pane");
    expect(
      textarea("skill-body").value,
    ).toContain("Publish body text.");
  });

  it("opening the BUNDLED row in the union highlights exactly one row", async () => {
      // The day-one union: a user-global artifacts AND the bundled one.
      // View-mode matching is scope-checked — a name-only match would
      // highlight both rows at once.
      lib.skills = [
        skill("artifacts"),
        bundled("artifacts"),
      ];
      await host.mount();
      // Open the BUNDLED row (the last one carrying the name).
      const rows = Array.from(
        document.querySelectorAll<HTMLButtonElement>(".library__item"),
      );
      const bundledRow = rows.reverse().find(
        (b) => b.querySelector(".library__item-name")?.textContent === "artifacts",
      )!;
      await act(async () => {
        bundledRow.click();
      });
      expect(document.querySelector(".library__editor-head")).not.toBeNull();
      const active = document.querySelectorAll(".library__item--active");
      expect(active).toHaveLength(1);
    });

  it("the unlock hint shows while the artifacts setting is off, absent while on", async () => {
      // The both-ways pin §J named: the hint keys on the SETTING (not the
      // claim — the design's owned divergence), and unknown (null) hides it.
      lib.skills = [
        bundled("artifacts"),
      ];
      await host.mount();
      await act(async () => {
        row("artifacts")!.click();
      });

      // Setting OFF (a re-render with a changed snapshot flips the hint).
      settingsState.current = { artifacts: false } as Settings;
      await host.mount();
      const hint = document.querySelector(".library__readonly-hint");
      expect(hint?.textContent).toContain("Fleet artifacts");

      // Setting ON: absent.
      settingsState.current = { artifacts: true } as Settings;
      await host.mount();
      expect(document.querySelector(".library__readonly-hint")).toBeNull();

      // Boot-unknown (null): no hint on unknown.
      settingsState.current = null;
      await host.mount();
      expect(document.querySelector(".library__readonly-hint")).toBeNull();
    });

  it("the bundled group carries no + New button (the teaching is the affordance)", async () => {
  lib.skills = [
    bundled("artifacts"),
  ];
  await host.mount();
  // Global keeps its create affordance; Bundled does not.
  expect(buttonByTitle("New global skill")).toBeDefined();
  expect(buttonByTitle("New bundled skill")).toBeNull();
});
});
