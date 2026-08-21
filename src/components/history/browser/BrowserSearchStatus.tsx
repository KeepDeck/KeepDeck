interface BrowserSearchStatusProps {
  firstPagePending: boolean;
  scanning: boolean;
  hasRows: boolean;
}

export function BrowserSearchStatus({
  firstPagePending,
  scanning,
  hasRows,
}: BrowserSearchStatusProps) {
  if (!firstPagePending && !(scanning && hasRows)) return null;
  return (
    // One slot, one message — two at once would be porridge. The
    // SEARCH pending wins over the ambient indexing note: it
    // answers what the user just did (typed and is waiting on
    // THEIR results), while indexing is background state that
    // outlives the wait. Inside the field, so neither shifts
    // layout nor duplicates the empty-list placeholder.
    <span className={firstPagePending ? "browser__searching" : "browser__scanning"}>
      {firstPagePending ? "Searching…" : "Indexing…"}
    </span>
  );
}
