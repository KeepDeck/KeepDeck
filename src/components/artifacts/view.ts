import type { ArtifactMetaRow } from "../../ipc/artifacts";

/**
 * What the registry's body shows — the presentation model, decided away
 * from the markup.
 *
 * Five states that look alike from the outside: no workspace, a read
 * still out, a store that refused, a workspace with nothing in it, and
 * rows. Telling them apart is a decision, not a rendering. Left in the
 * JSX it was a chain of ternaries that the next state would have to be
 * threaded into by hand, beside the elements it also lays out, and with
 * no way to check the classification without a DOM.
 */
export type ArtifactsView =
  | { kind: "noWorkspace" }
  | { kind: "loading" }
  /** The store said why it cannot answer; its words, verbatim. */
  | { kind: "refusal"; message: string }
  | { kind: "empty" }
  /** A workspace that HAS artifacts, none of which the query names. A
   * different sentence from an empty workspace, and the difference is
   * the only thing that tells a user their search was the problem. It
   * carries a banner for the same reason the rows arm does: this is a
   * list we HAVE, and news about it belongs beside it. */
  | { kind: "noMatch"; query: string; banner: string | null }
  | {
      kind: "rows";
      rows: readonly ArtifactMetaRow[];
      /** A refusal that arrived while these rows were up — a failed
       * refresh, a failed open. It rides WITH them because there is
       * nowhere else for it to go, and because deciding that beside the
       * markup is how the two facts drift apart. */
      banner: string | null;
    };

/**
 * Which of the five, from the three facts that decide it.
 *
 * The order is the meaning. A list we have outranks a failure — whether
 * the query left rows on screen or none — so a read that fails while a
 * list is up never takes the list, or the box that filters it, away; the
 * banner carries the news instead. A refusal outranks emptiness, so a
 * store that could not answer is never read as a workspace that has
 * published nothing.
 */
export function viewOf(
  workspaceId: string | null,
  rows: readonly ArtifactMetaRow[] | null,
  error: string | null,
  query: string,
): ArtifactsView {
  if (workspaceId === null) return { kind: "noWorkspace" };
  if (rows === null) return { kind: "loading" };
  const matched = matching(rows, query);
  if (matched.length > 0) return { kind: "rows", rows: matched, banner: error };
  // A list we HAVE, filtered to nothing, is the QUERY's doing — and it
  // outranks a refusal for a reason that is not taste: the search box
  // renders for these two arms, so answering a failed refresh with a
  // refusal here takes the box away and strands the user with a query
  // they can no longer clear. The failure still shows, as a banner.
  if (rows.length > 0) {
    return { kind: "noMatch", query: query.trim(), banner: error };
  }
  if (error !== null) return { kind: "refusal", message: error };
  return { kind: "empty" };
}

/**
 * The rows a query names — its TITLE or its id, case-insensitively, by
 * substring.
 *
 * The id is searched beside the title because it is the half people are
 * given and the half they type: a teammate who was told `auth-flow`
 * searches for `auth-flow`, and a search that only read titles would
 * answer nothing to the one identifier the feature hands out.
 *
 * No index and no cache: the rows in hand ARE the population — the
 * store lists a workspace whole — and each is an id and a title, so a
 * pass over a thousand of them costs less than the keystroke that asked.
 */
export function matching(
  rows: readonly ArtifactMetaRow[],
  query: string,
): readonly ArtifactMetaRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return rows;
  return rows.filter(
    (row) =>
      row.title.toLowerCase().includes(needle) ||
      row.id.toLowerCase().includes(needle),
  );
}
