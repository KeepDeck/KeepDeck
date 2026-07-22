import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChangelogEntry } from "../../domain/changelog";
import { openUrl } from "../../ipc/app";

/**
 * The accumulated release notes a user will move to by accepting this update —
 * every published release between the installed version and the target. The
 * updater fetches and signature-verifies these from the channel's
 * `changelog.json`; this component only renders them. Entries arrive already
 * sliced and oldest-first (see `sliceChangelog`).
 *
 * Notes are the release bodies as written (Markdown). react-markdown compiles
 * to React elements, so raw HTML in a note is dropped (no rehype-raw) — the
 * channel is trusted (minisign-verified), but rendering stays inert by
 * construction. Links open in the user's browser; the webview hosts the deck,
 * not the document.
 */
export function UpdateChangelog({
  entries,
}: {
  entries: readonly ChangelogEntry[];
}) {
  if (entries.length === 0) return null;
  return (
    <div className="settings__changelog">
      <span className="form__label">What's new</span>
      <ol className="settings__changelog-list">
        {entries.map((entry) => (
          <li key={entry.version} className="settings__changelog-entry">
            <header className="settings__changelog-version">
              <span>{entry.version}</span>
              {entry.date ? (
                <time className="settings__changelog-date">{entry.date}</time>
              ) : null}
            </header>
            <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {entry.notes}
            </Markdown>
          </li>
        ))}
      </ol>
    </div>
  );
}

const markdownComponents: Components = {
  a({ href, children, node: _node, ...rest }) {
    const external = typeof href === "string" && /^https?:\/\//i.test(href);
    return (
      <a
        {...rest}
        href={href}
        onClick={(event) => {
          // A naive click would navigate the WHOLE app webview. External links
          // go to the default browser; anything else stays inert.
          event.preventDefault();
          if (external && href) void openUrl(href);
        }}
      >
        {children}
      </a>
    );
  },
};
