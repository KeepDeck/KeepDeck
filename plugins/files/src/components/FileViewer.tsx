import { useEffect, useState } from "react";
import type { FsFile } from "@keepdeck/plugin-api";
import { Peek } from "@keepdeck/ui-kit/Peek";
import { getRuntime } from "../runtime";
import { baseName } from "../domain/tree";
import { OpenExternalIcon, WrapIcon } from "../icons";

/**
 * The file preview, inside the shared `Peek` overlay (ui-kit) — the shell
 * (backdrop, header, Esc/backdrop dismissal) is the kit's; this component owns
 * what fills it. Reads through `services.fs` (capped, binary-aware). Text
 * renders line-numbered — soft-wrapped or horizontally scrolled per the wrap
 * toggle; binary or oversized files defer to the external app. A stale
 * in-flight read is ignored so a fast reopen never flashes the wrong file.
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
  const [wrap, setWrap] = useState(false);

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

  const openExternally = () => void getRuntime().services.opener.openPath(path);

  return (
    <Peek
      ariaLabel={`Preview of ${baseName(path)}`}
      name={baseName(path)}
      meta={
        file ? <span className="peek__meta">{formatBytes(file.size)}</span> : null
      }
      actions={
        <>
          {file && !file.isBinary && file.text !== null && (
            <button
              type="button"
              className={`peek__act${wrap ? " peek__act--on" : ""}`}
              onClick={() => setWrap((w) => !w)}
              title={wrap ? "Don't wrap lines" : "Wrap lines"}
              aria-label="Toggle line wrapping"
              aria-pressed={wrap}
            >
              <WrapIcon />
            </button>
          )}
          <button
            type="button"
            className="peek__act"
            onClick={openExternally}
            title="Open in the default app"
            aria-label={`Open ${baseName(path)} in the default app`}
          >
            <OpenExternalIcon />
          </button>
        </>
      }
      path={breadcrumb(root, path)}
      onClose={onClose}
    >
      {loading && <p className="peek__note">Loading…</p>}
      {error && <p className="peek__note peek__note--bad">{error}</p>}
      {file && file.isBinary && (
        <div className="files__binary">
          <p className="peek__note">Binary file · {formatBytes(file.size)}</p>
          <button type="button" className="form__create" onClick={openExternally}>
            Open in the default app
          </button>
        </div>
      )}
      {file && !file.isBinary && file.text !== null && (
        <TextView
          text={file.text}
          wrap={wrap}
          truncated={file.truncated}
          size={file.size}
        />
      )}
    </Peek>
  );
}

/** Monospace text with a sticky line-number gutter. Each line is its own row so
 * the gutter and code stay aligned; long lines soft-wrap or scroll horizontally
 * under the gutter, which stays pinned left. */
function TextView({
  text,
  wrap,
  truncated,
  size,
}: {
  text: string;
  wrap: boolean;
  truncated: boolean;
  size: number;
}) {
  const lines = text.split("\n");
  return (
    <>
      <div className={`files__code${wrap ? " files__code--wrap" : ""}`}>
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
        <p className="peek__note peek__note--bad">
          Preview truncated — file is {formatBytes(size)}. Open it in the default
          app to see the rest.
        </p>
      )}
    </>
  );
}

/** The file's path relative to the tree root — best effort. Falls back to the
 * tail from the root folder's name (canonicalization can make the two disagree)
 * and finally the absolute path. No root at all (a terminal-link open, which
 * has no tree) shows the absolute path verbatim — NOT the leading-slash-
 * stripped remainder a `""` base would otherwise produce. */
function breadcrumb(root: string, path: string): string {
  const base = root.replace(/[/\\]+$/, "");
  if (!base) return path;
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
