/**
 * The open task's card as rows of one windowed list (task-280) — the way
 * a RecyclerView lays a whole screen out as items of several kinds: the
 * story with its properties, the comments' heading, each comment, the
 * activity's toggle, each change. The head above the rows and the comment
 * field under them stay put; everything between scrolls as one list, and
 * only what is in view is drawn.
 */
import type { CommentItem, FeedChange, TaskDetailView } from "./taskDetailView";

export type CardRow =
  /** The brief and the task's properties — one block, side by side when
   * the card is wide. */
  | { kind: "story" }
  /** The comments' heading, and the word for none. */
  | { kind: "comments" }
  | { kind: "comment"; comment: CommentItem }
  /** The activity's toggle, and — opened with nothing in it — the word for none. */
  | { kind: "activity" }
  | { kind: "change"; change: FeedChange };

/** The card's rows, in reading order: the activity's changes only while it is open. */
export function cardRows(view: Pick<TaskDetailView, "comments" | "changes" | "activity">): CardRow[] {
  return [
    { kind: "story" },
    { kind: "comments" },
    ...view.comments.map((comment): CardRow => ({ kind: "comment", comment })),
    { kind: "activity" },
    ...(view.activity.open ? view.changes.map((change): CardRow => ({ kind: "change", change })) : []),
  ];
}

/** A row's identity: its kind, and the comment's or change's own key —
 * never the index (a new comment must not hand its height to the toggle). */
export function cardRowKey(row: CardRow): string {
  switch (row.kind) {
    case "comment":
      return `comment:${row.comment.key}`;
    case "change":
      return `change:${row.change.key}`;
    default:
      return row.kind;
  }
}

/** Characters a comment's line holds at the card's width — the estimate's
 * guess only; every row is measured the moment it is drawn. */
const COMMENT_CHARS_PER_LINE = 56;
const COMMENT_LINE_PX = 19;
/** A comment tile's who line, padding and the gap under it. */
const COMMENT_FRAME_PX = 46;

/** A row's first-paint height, corrected by measurement. */
export function cardRowEstimate(row: CardRow): number {
  switch (row.kind) {
    case "story":
      return 320;
    case "comments":
      return 34;
    case "comment": {
      const lines = row.comment.body.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / COMMENT_CHARS_PER_LINE)), 0);
      return COMMENT_FRAME_PX + lines * COMMENT_LINE_PX;
    }
    case "activity":
      return 36;
    case "change":
      return 24;
  }
}
