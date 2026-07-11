import { useEffect, useState } from "react";
import {
  subscribeOpenRequests,
  takeOpenRequest,
  type OpenRequest,
} from "../openRequests";
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
