import { useEffect, useState } from "react";
import type { FsFile } from "@keepdeck/plugin-api";
import { CloseIcon } from "@keepdeck/ui-kit/icons";
import { getRuntime } from "../runtime";
import { baseName } from "../domain/tree";
import { OpenExternalIcon } from "../icons";

/**
 * The read-only preview of one selected file. Reads it through `services.fs`
 * (capped, binary-aware): text renders line-numbered; a binary or unreadable
 * file shows a notice and an "open in the default app" escape hatch
 * (`services.opener`, the `open` capability). Re-reads whenever `path` changes;
 * a stale in-flight read is ignored so a fast click-through never flashes the
 * wrong file.
 */
export function FileViewer({
  path,
  onClose,
}: {
  path: string;
  onClose: () => void;
}) {
  const [file, setFile] = useState<FsFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
    <div className="files__viewer">
      <div className="files__vhead" title={path}>
        <span className="files__vname">{baseName(path)}</span>
        {file && <span className="files__vmeta">{formatBytes(file.size)}</span>}
        <button
          type="button"
          className="files__vact"
          onClick={openExternally}
          title="Open in the default app"
          aria-label={`Open ${baseName(path)} in the default app`}
        >
          <OpenExternalIcon />
        </button>
        <button
          type="button"
          className="files__vact"
          onClick={onClose}
          title="Close the preview"
          aria-label="Close the preview"
        >
          <CloseIcon />
        </button>
      </div>
      <div className="files__vbody">
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

/** Monospace text with a line-number gutter. Each line is its own row so the
 * gutter and the code stay aligned regardless of wrapping being off. */
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
            {/* A no-break space keeps an empty line's row height. */}
            <span className="files__linetext">{line || " "}</span>
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

/** Human byte size: B / KB / MB with one decimal above a kilobyte. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
