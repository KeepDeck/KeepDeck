import { describe, expect, it } from "vitest";
import { planDelete, type DeletableArtifact } from "./delete";

const artifact = (over: Partial<DeletableArtifact> = {}): DeletableArtifact => ({
  slug: "auth-flow" as DeletableArtifact["slug"],
  format: "html",
  versionCount: 5,
  createdAt: 1786800000000,
  ...over,
});

describe("planDelete", () => {
  it("deletes a present artifact, carrying the informative metadata", () => {
    expect(planDelete(artifact())).toEqual({
      deleted: true,
      versionCount: 5,
      createdAt: 1786800000000,
    });
  });

  it("a present artifact with many versions carries the count — a cleaner seeing a YOUNG count right after deleting an old chain learns a resurrection happened", () => {
    const old = planDelete(artifact({ versionCount: 40 }));
    expect(old).toEqual({ deleted: true, versionCount: 40, createdAt: 1786800000000 });
  });

  it("an absent artifact is a no-op SUCCESS, never an error", () => {
    expect(planDelete(null)).toEqual({
      deleted: false,
      versionCount: null,
      createdAt: null,
    });
  });

  it("the idempotency mirror: two plans against one existing → true then false", () => {
    // First delete plans against the live artifact; the retry plans
    // against what the store holds AFTER the first landed: nothing.
    const first = planDelete(artifact());
    const retry = planDelete(null);
    expect(first.deleted).toBe(true);
    expect(retry.deleted).toBe(false);
  });

  it("no API weight: the plan shape carries no expected-version or CAS field", () => {
    const plan = planDelete(artifact());
    const keys = Object.keys(plan).sort();
    expect(keys).toEqual(["createdAt", "deleted", "versionCount"]);
  });
});
