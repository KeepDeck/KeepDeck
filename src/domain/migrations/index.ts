/**
 * Migrations — schema revisions for every durable JSON document (version =
 * revision that wrote the file, minVersion = compatibility floor) and the
 * ladders that climb older files up. Shared by the deck document codec and
 * the settings codec; the one package to touch when a document's shape moves.
 */
export * from "./migrations";
