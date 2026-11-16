import { ALL_ARCHIVED_WORDS } from "../../presentation/deckPresence";
import { Button } from "../../ui/Button";

/** The stage when every workspace is archived: where they went, and the two
 * ways on — back to one of them, or a new one. */
export function AllArchivedStage({ onOpenArchived, onCreate }: { onOpenArchived(): void; onCreate(): void }) {
  return (
    <div className="all-archived" role="status">
      <h2 className="all-archived__title">{ALL_ARCHIVED_WORDS.title}</h2>
      <p className="all-archived__body">{ALL_ARCHIVED_WORDS.body}</p>
      <div className="all-archived__acts">
        <Button variant="primary" onClick={onOpenArchived}>
          {ALL_ARCHIVED_WORDS.open}
        </Button>
        <Button variant="secondary" onClick={onCreate}>
          {ALL_ARCHIVED_WORDS.create}
        </Button>
      </div>
    </div>
  );
}
