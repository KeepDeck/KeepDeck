import { describe, expect, it } from "vitest";
import { roleById, teamRoles } from "../domain/mail";
import { roleChoiceView } from "./roleChoiceView";

describe("roleChoiceView", () => {
  it("offers every catalog role, labelled, in catalog order", () => {
    const view = roleChoiceView([]);
    expect(view.options).toEqual(teamRoles().map((role) => ({ value: role.id, label: role.label })));
  });

  it("opens on the lead for a team with nobody on it, and on the next implementer beside a lead", () => {
    expect(roleChoiceView([]).defaultId).toBe("lead");
    expect(roleChoiceView(["lead"]).defaultId).toBe("impl");
  });

  it("mints the address past what the roster holds, and refuses a held singleton", () => {
    const view = roleChoiceView(["lead", "impl-1"]);
    expect(view.addressFor("impl")).toBe("impl-2");
    expect(view.addressFor("lead")).toBeNull();
  });

  it("labels a role the catalog knows, and falls back to the id for one it has lost", () => {
    const view = roleChoiceView([]);
    expect(view.labelOf("impl")).toBe(roleById("impl")!.label);
    expect(view.labelOf("wizard")).toBe("wizard");
    expect(view.addressFor("wizard")).toBeNull();
  });
});
