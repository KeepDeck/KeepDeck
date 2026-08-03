/**
 * Panes, as one thing: the model plus everything asked of it.
 *
 * A pure re-export barrel and nothing else — it DEFINES nothing, so no sibling
 * ever has to import from it to reach a shape or a mint, which is what made
 * the previous arrangement a cycle.
 */
export * from "./model";
export * from "./collection";
export * from "./factories";
export * from "./lifecycle";
export * from "./titles";
