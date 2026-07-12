import { useEffect, useState } from "react";
import type { FsFile } from "@keepdeck/plugin-api";
import { Peek } from "@keepdeck/ui-kit/Peek";
import { langFor, TokenLine, useHighlight } from "@keepdeck/code-kit";
import { getRuntime } from "../runtime";
import { baseName } from "../domain/tree";
import { CodeIcon, OpenExternalIcon, WrapIcon } from "../icons";
import { MarkdownView } from "./MarkdownView";

/**
 * The file preview, inside the shared `Peek` overlay (ui-kit) — the shell
 * (backdrop, header, Esc/backdrop dismissal) is the kit's; this component owns
 * what fills it. Reads through `services.fs` (capped, binary-aware). Text
 * renders line-numbered — syntax-colored when the path maps to a grammar
 * (code-kit; plain first, recolored when tokens land) — soft-wrapped or
 * horizontally scrolled per the wrap toggle. Markdown renders as a document
 * by default, with a header toggle back to the raw line view; binary or
 * oversized files defer to the external app. A stale in-flight read is
 * ignored so a fast reopen never flashes the wrong file.
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
  const [rawMarkdown, setRawMarkdown] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    setError(null);
    setLoading(true);
    // A per-file view choice, not a session preference: the next file opens
    // in its own default view again.
    setRawMarkdown(false);
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
  const hasText = file !== null && !file.isBinary && file.text !== null;
  const markdown = langFor(path) === "markdown";
  // The document view has no lines to wrap or number — those controls belong
  // to the raw view only.
  const showRendered = markdown && !rawMarkdown;

  return (
    <Peek
      ariaLabel={`Preview of ${baseName(path)}`}
      name={baseName(path)}
      meta={
        file ? <span className="peek__meta">{formatBytes(file.size)}</span> : null
      }
      actions={
        <>
          {hasText && markdown && (
            <button
              type="button"
              className={`peek__act${rawMarkdown ? " peek__act--on" : ""}`}
              onClick={() => setRawMarkdown((raw) => !raw)}
              title={rawMarkdown ? "Show rendered Markdown" : "Show Markdown source"}
              aria-label="Toggle Markdown source view"
              aria-pressed={rawMarkdown}
            >
              <CodeIcon />
            </button>
          )}
          {hasText && !showRendered && (
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
      {file && !file.isBinary && file.text !== null && showRendered && (
        <>
          <MarkdownView text={file.text} />
          {file.truncated && <TruncatedNote size={file.size} />}
        </>
      )}
      {file && !file.isBinary && file.text !== null && !showRendered && (
        <TextView
          text={file.text}
          path={path}
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
 * under the gutter, which stays pinned left. Syntax color arrives progressively
 * (code-kit's useHighlight): the plain text is on screen at once, and the rows
 * recolor when tokenization lands — or never do, for an unknown language or an
 * over-limit file, which is exactly the old plain view. */
function TextView({
  text,
  path,
  wrap,
  truncated,
  size,
}: {
  text: string;
  path: string;
  wrap: boolean;
  truncated: boolean;
  size: number;
}) {
  const lines = text.split("\n");
  const tokens = useHighlight(text, langFor(path));
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
            <span className="files__linetext">
              {tokens ? <TokenLine tokens={tokens[index]} /> : line || " "}
            </span>
          </div>
        ))}
      </div>
      {truncated && <TruncatedNote size={size} />}
    </>
  );
}

/** The read stopped at the fs cap — say so under either view, in one voice. */
function TruncatedNote({ size }: { size: number }) {
  return (
    <p className="peek__note peek__note--bad">
      Preview truncated — file is {formatBytes(size)}. Open it in the default
      app to see the rest.
    </p>
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
