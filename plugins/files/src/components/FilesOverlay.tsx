import { useEffect, useState } from "react";
import {
  subscribeOpenRequests,
  takeOpenRequest,
  type OpenRequest,
} from "../openRequests";
import { getRuntime } from "../runtime";
import { FileViewer } from "./FileViewer";

/**
 * The plugin's resident viewer — the SINGLE consumer of open requests from
 * both producers (the terminal-link handler and the tree's open gestures),
 * rendering the one `FileViewer` for either. Registered as a host overlay,
 * so it lives while the plugin is active regardless of any dock state: a
 * terminal link opens the peek without touching a panel, and closing it
 * leaves the layout exactly as it was. Empty until a request arrives.
 */
export function FilesOverlay() {
  const [request, setRequest] = useState<OpenRequest | null>(null);

  useEffect(() => {
    const consume = () => {
      const next = takeOpenRequest();
      if (next) setRequest(next);
    };
    // A request may predate this mount (activation and render are async to
    // the click); the take-based consume is naturally StrictMode-safe — a
    // re-invoked effect finds the slot empty and touches nothing.
    consume();
    return subscribeOpenRequests(consume);
  }, []);

  // The host cannot see a full-window peek by itself — this overlay is
  // "visible" while it renders nothing — so the viewer says when it covers
  // the deck and when it stops: hotkeys pause behind it, and a pane under it
  // is not on screen for a notification. Unsaid on unmount too; the runtime
  // may already be gone on that path, and the host clears a retired
  // plugin's cover on its own.
  const covers = request !== null;
  useEffect(() => {
    const say = (value: boolean) => {
      try {
        getRuntime().ui.setOverlayCovers("viewer", value);
      } catch {
        // Torn down.
      }
    };
    say(covers);
    return () => {
      if (covers) say(false);
    };
  }, [covers]);

  if (!request) return null;
  return (
    <FileViewer
      path={request.path}
      root={request.root ?? ""}
      onClose={() => {
        setRequest(null);
        request.onClose?.();
      }}
    />
  );
}
