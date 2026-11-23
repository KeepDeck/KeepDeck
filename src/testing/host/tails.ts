// What the page asked the app's native tailer for, read off the tape: the
// files it followed for a pane, the ones it let go of, narrowed and linked.
import { callsOf, repliedTo, type Host } from "./host";

/** A field of a value read off the tape. */
export const field = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined);

/** The calls of `cmd` the page made for the pane, from `mark` on. */
const forPane = (host: Host, cmd: string, paneId: string, mark: number) => callsOf(host, cmd, mark).filter((args) => field(args, "paneId") === paneId);

/** The tails the page asked the app to follow for the pane, each as asked. */
export const tailsOf = (host: Host, paneId: string, mark = 0): unknown[] => forPane(host, "usage_watch_session_file", paneId, mark).map((args) => field(args, "tail"));

/** The lanes each of a tail's watches feeds, in their order. */
export const lanesOf = (tail: unknown): unknown[] => {
  const watches = field(tail, "watches");
  return Array.isArray(watches) ? watches.map((watch) => field(watch, "lane")) : [];
};

/** How many times the page let go of the pane's file, from `mark` on. */
export const unwatches = (host: Host, paneId: string, mark = 0): number => forPane(host, "usage_unwatch_session_file", paneId, mark).length;

/** The narrowings the page asked of the pane's tail, from `mark` on: the
 * watches each kept. */
export const narrowings = (host: Host, paneId: string, mark = 0): unknown[] => forPane(host, "usage_retarget_session_file", paneId, mark).map((args) => field(args, "watches"));

/** The stores the page linked into the pane's tail, from `mark` on. */
export const linked = (host: Host, paneId: string, mark = 0): unknown[] => forPane(host, "usage_link_session_file", paneId, mark).map((args) => field(args, "path"));

/** Whether the app has followed the pane's file: a watch it answered. */
export const followed = (host: Host, paneId: string): boolean => repliedTo(host, "usage_watch_session_file").some((args) => field(args, "paneId") === paneId);
