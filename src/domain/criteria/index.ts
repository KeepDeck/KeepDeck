/**
 * Criteria — the app-wide concept for "is this surface / behavior available
 * right now?": named, composable yes/no rules over explicit structural
 * contexts. Features declare criterion INSTANCES (e.g. domain/run's
 * criteria.ts); components evaluate declarations instead of reading flags.
 */
export * from "./criteria";
