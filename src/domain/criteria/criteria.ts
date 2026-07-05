/**
 * Criteria — the app-wide concept for "is this surface / behavior available
 * right now?". A criterion is a NAMED, COMPOSABLE yes/no rule over an
 * explicit context. Features declare their conditions as criterion VALUES —
 * domain data, one declaration per surface — instead of scattering boolean
 * expressions through components; composition (`all`/`any`/`not`) builds
 * compound rules out of named parts that stay individually testable, and a
 * requirement change is an edit to one declaration.
 *
 * Contexts are structural: a criterion over `{ settings }` composes into a
 * rule over any richer context — members only read what they declare.
 */
export interface Criterion<C> {
  /** Stable kebab-case name — what tests and debugging call the rule. */
  readonly id: string;
  readonly satisfiedBy: (ctx: C) => boolean;
}

/** Define an atomic criterion. */
export function criterion<C>(
  id: string,
  satisfiedBy: (ctx: C) => boolean,
): Criterion<C> {
  return { id, satisfiedBy };
}

/** Satisfied only when EVERY member is. */
export function all<C>(id: string, ...members: Criterion<C>[]): Criterion<C> {
  return criterion(id, (ctx) => members.every((m) => m.satisfiedBy(ctx)));
}

/** Satisfied when AT LEAST ONE member is. */
export function any<C>(id: string, ...members: Criterion<C>[]): Criterion<C> {
  return criterion(id, (ctx) => members.some((m) => m.satisfiedBy(ctx)));
}

/** The member's negation. */
export function not<C>(id: string, member: Criterion<C>): Criterion<C> {
  return criterion(id, (ctx) => !member.satisfiedBy(ctx));
}
