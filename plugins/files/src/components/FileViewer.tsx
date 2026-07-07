import { useEffect, useRef, useState } from "react";
import type { FsFile } from "@keepdeck/plugin-api";
import { getRuntime } from "../runtime";
import { baseName } from "../domain/tree";
import { BackIcon, OpenExternalIcon } from "../icons";

/**
 * The full-panel file preview — a drill-in over the tree, not a cramped bottom
 * strip: in a narrow dock the only way a code view earns its keep is to take
 * the whole panel. Header carries a back affordance, the name, its size, and an
 * "open in the default app" escape hatch; a breadcrumb shows where the file
 * sits in the tree; the body is the file itself.
 *
 * Reads through `services.fs` (capped, binary-aware). Text renders
 * line-numbered with a sticky gutter and horizontal scroll for long lines; a
 * binary or oversized file shows a notice and defers to the external app. A
 * stale in-flight read is ignored, so stepping between files never flashes the
 * wrong one. `Esc` (or the back button) returns to the tree.
 */
export function FileViewer({
  path,
  root,
  onClose,
}: {
  path: string;
  root: string;
  onClose: () => void;
}) {
  const [file, setFile] = useState<FsFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setError(null);
    setLoading(true);
    const { services, log } = getRuntime();
    services.fs
      .readFile(path)
      .then((result) => {
        if (cancelled) return;
        setFile(result);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        log.warn(`readFile failed for ${path}: ${message}`);
        if (cancelled) return;
        setError(message);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  // Focus the scroll body so arrow keys scroll the code; Esc closes from
  // anywhere inside via the container handler below.
  useEffect(() => {
    bodyRef.current?.focus();
  }, []);

  const openExternally = () => void getRuntime().services.opener.openPath(path);
  const trail = breadcrumb(root, path);

  return (
    <div
      className="files__detail"
      role="group"
      aria-label={`Preview of ${baseName(path)}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="files__dhead">
        <button
          type="button"
          className="files__dback"
          onClick={onClose}
          title="Back to the tree"
          aria-label="Back to the tree"
        >
          <BackIcon />
        </button>
        <span className="files__dname" title={path}>
          {baseName(path)}
        </span>
        {file && <span className="files__dsize">{formatBytes(file.size)}</span>}
        <button
          type="button"
          className="files__dact"
          onClick={openExternally}
          title="Open in the default app"
          aria-label={`Open ${baseName(path)} in the default app`}
        >
          <OpenExternalIcon />
        </button>
      </div>
      {trail && (
        <div className="files__dpath" title={path}>
          {trail}
        </div>
      )}
      <div className="files__dbody" ref={bodyRef} tabIndex={0}>
        {loading && <p className="files__note">Loading…</p>}
        {error && <p className="files__note files__note--bad">{error}</p>}
        {file && file.isBinary && (
          <div className="files__binary">
            <p className="files__note">Binary file · {formatBytes(file.size)}</p>
            <button
              type="button"
              className="form__create"
              onClick={openExternally}
            >
              Open in the default app
            </button>
          </div>
        )}
        {file && !file.isBinary && file.text !== null && (
          <TextView text={file.text} truncated={file.truncated} size={file.size} />
        )}
      </div>
    </div>
  );
}

/** Monospace text with a sticky line-number gutter. Each line is its own row so
 * the gutter and code stay aligned; long lines scroll horizontally under the
 * gutter, which stays pinned left. */
function TextView({
  text,
  truncated,
  size,
}: {
  text: string;
  truncated: boolean;
  size: number;
}) {
  const lines = text.split("\n");
  return (
    <>
      <div className="files__code">
        {lines.map((line, index) => (
          // Lines are positional and never reordered — index is a stable key.
          <div className="files__coderow" key={index}>
            <span className="files__lineno" aria-hidden>
              {index + 1}
            </span>
            {/* A space keeps an empty line's row height under white-space: pre. */}
            <span className="files__linetext">{line || " "}</span>
          </div>
        ))}
      </div>
      {truncated && (
        <p className="files__note files__note--bad">
          Preview truncated — file is {formatBytes(size)}. Open it in the default
          app to see the rest.
        </p>
      )}
    </>
  );
}

/** The file's path relative to the tree root — best effort. Falls back to the
 * tail from the root folder's name (canonicalization can make the two disagree)
 * and finally the absolute path. Empty when the file IS the root (never, for a
 * file). */
function breadcrumb(root: string, path: string): string {
  const base = root.replace(/[/\\]+$/, "");
  if (path === base) return "";
  if (path.startsWith(`${base}/`)) return path.slice(base.length + 1);
  const marker = `/${baseName(base)}/`;
  const at = path.indexOf(marker);
  return at >= 0 ? path.slice(at + marker.length) : path;
}

/** Human byte size: B / KB / MB with one decimal above a kilobyte. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
