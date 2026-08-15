/**
 * The publish decision, as a pure function — every §2 semantic the store
 * then executes under its mutation mutex. Pinned HERE so the Rust store
 * and the tests share one definition of the rules, and so a race in the
 * wild is a mismatch against a spec, not folklore.
 *
 * The three outcomes, and the decisions that choose between them:
 * - `create` — no artifact owns the slug yet; the publisher names it and
 *   its format becomes the artifact's PINNED format.
 * - `append` — the slug exists (shared canvas): any workspace pane may
 *   republish, the version chain grows, the author is recorded per
 *   version. A format flip is refused naming the original.
 * - `error` — a refusal the agent can act on, never a protocol error.
 *
 * Collision policy is the explicit/minted split: an EXPLICIT slug that
 * collides is an error naming the slug (it protects mail references); a
 * MINTED slug that collides has no references to protect — the planner
 * retries with `-2`, `-3`, … (bounded), because a just-minted slug never
 * promised anyone anything.
 */
import {
  SLUG_MAX,
  validateSlug,
  validateTitle,
  type ArtifactFormat,
  type Slug,
} from "./model";

/** What the planner needs to know about the artifact a slug names —
 * the manifest's decision-relevant slice. `null` when the store holds no
 * artifact under the slug. */
export interface ExistingArtifact {
  slug: Slug;
  format: ArtifactFormat;
  versionCount: number;
}

/** A publish request after arg validation (title/format/caps are the
 * command layer's checks; this planner decides slug identity). */
export interface PublishRequest {
  /** The caller chose a slug. Absent = mint from the title. */
  slug?: string;
  title: string;
  format: ArtifactFormat;
}

export type PublishPlan =
  | { kind: "create"; slug: Slug; format: ArtifactFormat }
  | { kind: "append"; slug: Slug; nextVersion: number };

/** A refusal reason as a full sentence the agent can act on — the command
 * layer surfaces these verbatim via isError:true. */
export type PublishRefusal =
  | "invalid-slug"
  | "invalid-title"
  | "format-pinned";

/** Bounded mint retries: `-2`, `-3`, … past the derived slug. The bound
 * exists so a pathological title colliding 50 times is an error, not a
 * scan; real titles never approach it. */
export const MINT_RETRY_MAX = 8;

/** Normalize a title into a slug-shaped candidate: lowercase → collapse
 * every non-[a-z0-9] run into one dash → trim dashes → truncate to the
 * grammar's 64 → `"artifact"` when nothing survives (a title of pure
 * punctuation must still yield a legal slug). */
export function mintSlugFromTitle(title: string): string {
  const derived = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return derived === "" ? "artifact" : derived;
}

/** Does `slug` name a live artifact? The caller supplies the lookup so
 * the planner stays pure — the store's `exists` is a manifest probe, the
 * tests' is a map. */
export interface PublishDeps {
  exists(slug: Slug): boolean;
}

/**
 * Plan one publish. The collision policy, by slug provenance:
 * - EXPLICIT slug: `existing` (the store's answer for THIS slug) names the
 *   canvas — same artifact means append (shared canvas: any pane may
 *   republish), no artifact means the name is free to create.
 * - MINTED slug: `existing` is IGNORED. A derived name has no references
 *   to protect, so every collision retries with the next suffix — even
 *   landing on the base of another artifact (a stranger's canvas) is a
 *   retry, never a silent join. Same-canvas iteration is what explicit
 *   ids are for; the skill teaches naming them.
 *
 * The retry sequence is base, -2, -3, … (bounded by MINT_RETRY_MAX); each
 * candidate is budgeted to the grammar's 64 by truncating the BASE — never
 * the suffix, which is the part that makes the name distinct. validateSlug
 * gates every candidate through a checked branch: no unvalidated slug ever
 * leaves this function.
 */
export function planPublish(
  existing: ExistingArtifact | null,
  request: PublishRequest,
  deps: PublishDeps,
): PublishPlan | { kind: "error"; reason: PublishRefusal; detail?: string } {
  const title = validateTitle(request.title);
  if (title === null) return { kind: "error", reason: "invalid-title" };

  // Explicit slug: `existing` IS the store's answer for this slug — the
  // same artifact means append (shared canvas: any pane may republish),
  // no answer means the name is free. deps.exists is the MINT loop's
  // occupancy probe and never consulted here: a second source of truth
  // about the same name would be the stale-snapshot bug in miniature.
  if (request.slug !== undefined) {
    const slug = validateSlug(request.slug);
    if (slug === null) return { kind: "error", reason: "invalid-slug" };
    if (existing !== null && existing.slug === slug) {
      if (existing.format !== request.format) {
        return {
          kind: "error",
          reason: "format-pinned",
          detail: `${slug} is ${existing.format}; publish a new artifact for ${request.format}`,
        };
      }
      return { kind: "append", slug, nextVersion: existing.versionCount + 1 };
    }
    return { kind: "create", slug, format: request.format };
  }

  // Minted slug: retry past EVERY collision — occupancy is deps.exists'
  // one question, `existing` carries no ownership and is not consulted.
  const base = mintSlugFromTitle(title);
  for (let attempt = 1; attempt <= MINT_RETRY_MAX; attempt++) {
    const suffix = attempt === 1 ? "" : `-${attempt}`;
    const head = base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, "");
    const candidate = validateSlug(head + suffix);
    if (candidate === null) continue;
    if (!deps.exists(candidate)) {
      return { kind: "create", slug: candidate, format: request.format };
    }
  }
  return { kind: "error", reason: "invalid-slug", detail: "mint retries exhausted" };
}
