import { describe, expect, it } from "vitest";
import {
  MINT_RETRY_MAX,
  mintSlugFromTitle,
  planPublish,
  type ExistingArtifact,
  type PublishDeps,
} from "./publish";

const existing = (over: Partial<ExistingArtifact> = {}): ExistingArtifact => ({
  slug: "auth-flow" as ExistingArtifact["slug"],
  format: "html",
  versionCount: 3,
  ...over,
});

/** A deps double: a name-set, so `exists` is honest about occupancy. */
const names = (...taken: string[]): PublishDeps => {
  const set = new Set(taken);
  return { exists: (slug) => set.has(slug) };
};

describe("explicit slug", () => {
  it("creates when the name is free", () => {
    const plan = planPublish(null, { slug: "new-thing", title: "T", format: "md" }, names());
    expect(plan).toEqual({ kind: "create", slug: "new-thing", format: "md" });
  });

  it("refuses an off-grammar slug", () => {
    const plan = planPublish(null, { slug: "Bad_Slug", title: "T", format: "md" }, names());
    expect(plan).toEqual({ kind: "error", reason: "invalid-slug" });
  });

  it("appends when the same artifact is republished (shared canvas)", () => {
    const plan = planPublish(
      existing(),
      { slug: "auth-flow", title: "T", format: "html" },
      names("auth-flow"),
    );
    expect(plan).toEqual({ kind: "append", slug: "auth-flow", nextVersion: 4 });
  });

  it("refuses a format flip naming the original format", () => {
    const plan = planPublish(
      existing(),
      { slug: "auth-flow", title: "T", format: "md" },
      names("auth-flow"),
    );
    expect(plan).toEqual({
      kind: "error",
      reason: "format-pinned",
      detail: "auth-flow is html; publish a new artifact for md",
    });
  });

  it("creates when the explicit slug names a DIFFERENT artifact than `existing`", () => {
    // The command layer passes the artifact this slug names (or null); an
    // explicit slug pointing elsewhere is a fresh create, not a collision
    // with the caller's own canvas.
    const plan = planPublish(
      existing(),
      { slug: "other-thing", title: "T", format: "html" },
      names("auth-flow"),
    );
    expect(plan).toEqual({ kind: "create", slug: "other-thing", format: "html" });
  });
});

describe("minted slug", () => {
  it("derives from the title: lowercase, collapse, trim, truncate", () => {
    expect(mintSlugFromTitle("Deploy Failures by Service!")).toBe(
      "deploy-failures-by-service",
    );
    expect(mintSlugFromTitle("  ---Auth & Flow---  ")).toBe("auth-flow");
    expect(mintSlugFromTitle("！！！")).toBe("artifact");
    expect(mintSlugFromTitle("A".repeat(100))).toHaveLength(64);
    // Truncation must not leave a trailing dash.
    expect(mintSlugFromTitle("A".repeat(100)).endsWith("-")).toBe(false);
  });

  it("mints the base when free", () => {
    const plan = planPublish(null, { title: "Auth Flow", format: "html" }, names());
    expect(plan).toEqual({ kind: "create", slug: "auth-flow", format: "html" });
  });

  it("retries -2, -3 past an occupied base (retry AFTER derivation)", () => {
    const plan = planPublish(
      null,
      { title: "Auth Flow", format: "html" },
      names("auth-flow", "auth-flow-2"),
    );
    expect(plan).toEqual({ kind: "create", slug: "auth-flow-3", format: "html" });
  });

  it("appends when the mint lands on THIS artifact's own name", () => {
    const plan = planPublish(
      existing(),
      { title: "Auth Flow", format: "html" },
      names("auth-flow"),
    );
    expect(plan).toEqual({ kind: "append", slug: "auth-flow", nextVersion: 4 });
  });

  it("refuses the format flip when the mint lands on this artifact", () => {
    const plan = planPublish(
      existing(),
      { title: "Auth Flow", format: "md" },
      names("auth-flow"),
    );
    expect(plan.kind).toBe("error");
    if (plan.kind === "error") {
      expect(plan.reason).toBe("format-pinned");
      expect(plan.detail).toContain("auth-flow is html");
    }
  });

  it("errors when MINT_RETRY_MAX attempts all collide", () => {
    // The candidate sequence is base, -2, -3 … -<MINT_RETRY_MAX>; occupy
    // every one of them.
    const taken: string[] = ["auth-flow"];
    for (let i = 2; i <= MINT_RETRY_MAX; i++) {
      taken.push(`auth-flow-${i}`);
    }
    const plan = planPublish(
      null,
      { title: "Auth Flow", format: "html" },
      names(...taken),
    );
    expect(plan).toEqual({
      kind: "error",
      reason: "invalid-slug",
      detail: "mint retries exhausted",
    });
  });

  it("retries -2 FIRST past an occupied base (the sequence is base, -2, -3…)", () => {
    // The discriminating case: ONLY the base is occupied — the next
    // candidate must be -2, not -3 (a skipped -2 breaks the
    // mail-vocabulary predictability the retry rule exists for).
    const plan = planPublish(
      null,
      { title: "Auth Flow", format: "html" },
      names("auth-flow"),
    );
    expect(plan).toEqual({ kind: "create", slug: "auth-flow-2", format: "html" });
  });

  it("a full-length base colliding yields a GRAMMAR-VALID suffixed candidate, never a null slug", () => {
    // 64-char base + suffix would exceed the grammar; the planner budgets
    // the base so the candidate stays legal — and never emits an
    // unvalidated slug (the create below carries a real string, not null).
    const base = mintSlugFromTitle("A".repeat(100));
    expect(base).toHaveLength(64);
    const plan = planPublish(
      null,
      { title: "A".repeat(100), format: "html" },
      names(base),
    );
    expect(plan.kind).toBe("create");
    if (plan.kind === "create") {
      expect(typeof plan.slug).toBe("string");
      expect(plan.slug).toHaveLength(64);
      expect(plan.slug.endsWith("-2")).toBe(true);
    }
  });
});

describe("title validation gates everything", () => {
  it("refuses an empty title before any slug work", () => {
    const plan = planPublish(null, { title: "", format: "html" }, names());
    expect(plan).toEqual({ kind: "error", reason: "invalid-title" });
  });
});

describe("the v1+v2 race mirror", () => {
  it("plan #2 re-plans against the UPDATED existing, not the stale snapshot", () => {
    // Two same-slug first-publishes serialize in the store; the mirror:
    // after plan #1's create lands, the racer plans against v1 EXISTING.
    const first = planPublish(null, { slug: "race", title: "T", format: "html" }, names());
    expect(first).toEqual({ kind: "create", slug: "race", format: "html" });

    // The racer's plan: the store now holds the artifact (v1).
    const afterCreate: ExistingArtifact = { slug: "race" as ExistingArtifact["slug"], format: "html", versionCount: 1 };
    const second = planPublish(
      afterCreate,
      { slug: "race", title: "T", format: "html" },
      names("race"),
    );
    expect(second).toEqual({ kind: "append", slug: "race", nextVersion: 2 });

    // The stale-snapshot pin, honest form: before the create lands, the
    // same explicit publish IS a create — that is the race's first half.
    // The regression pin is the line above: against the UPDATED existing
    // the racer appends. Two plans against one STALE (null) snapshot both
    // saying `create` is exactly what the store's mutex prevents.
    const beforeCreate = planPublish(null, { slug: "race", title: "T", format: "html" }, names());
    expect(beforeCreate.kind).toBe("create");
  });
});
