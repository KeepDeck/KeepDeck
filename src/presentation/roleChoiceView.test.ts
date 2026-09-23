import { describe, expect, it } from "vitest";
import { roleById } from "../domain/mail";
import { NO_ROLE, ROLE_WORDS, roleChoiceView } from "./roleChoiceView";

const values = (held: string[], picked = NO_ROLE) =>
  roleChoiceView(held).optionsFor(picked).map((option) => option.value);

describe("roleChoiceView", () => {
  it("offers only what the team is open to — a lead or a peer to a team with nobody on it", () => {
    expect(values([], "lead")).toEqual(["lead", "peer"]);
    expect(values(["lead"], "impl")).not.toContain("lead");
    expect(values(["lead"], "impl")).not.toContain("peer");
    expect(values(["peer-1"], "peer")).toEqual(["peer"]);
  });

  it("picks nothing in advance: the prompt leads the options until a role is picked", () => {
    expect(roleChoiceView([]).optionsFor(NO_ROLE)[0]).toEqual({ value: NO_ROLE, label: ROLE_WORDS.prompt });
    expect(roleChoiceView([]).addressFor(NO_ROLE)).toBeNull();
    expect(values([], "peer")).not.toContain(NO_ROLE);
  });

  it("labels each role from the catalog and gives the address a pick takes past the roster", () => {
    const view = roleChoiceView(["lead", "impl-1"]);
    expect(view.optionsFor("impl").find((option) => option.value === "impl")?.label).toBe(roleById("impl")!.label);
    expect(view.addressFor("impl")).toBe("impl-2");
    expect(view.addressFor("lead")).toBeNull();
  });

  it("says so when no role can join the roster as it stands", () => {
    expect(roleChoiceView([]).unpickedHint).toBe(ROLE_WORDS.unpicked);
    expect(roleChoiceView(["wizard-1"]).unpickedHint).toBe(ROLE_WORDS.closed);
  });

  it("keeps a pick only while the team is open to it", () => {
    expect(roleChoiceView([]).pickOf("peer")).toBe("peer");
    expect(roleChoiceView(["lead"]).pickOf("peer")).toBe(NO_ROLE);
    expect(roleChoiceView([]).pickOf(NO_ROLE)).toBe(NO_ROLE);
  });
});
