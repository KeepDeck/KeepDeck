/**
 * Tasks — the deck's work orders: a durable, team-owned board beside mail
 * (messages) and artifacts (shared objects). Pure rules; the app owner
 * persists a board and the commands and the dialog ask these.
 */
export * from "./model";
export * from "./board";
export * from "./transition";
export * from "./codec";
