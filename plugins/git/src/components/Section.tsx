import type { ReactNode } from "react";
import { ChevronIcon } from "@keepdeck/ui-kit/icons";
import type { SectionId } from "../presentation/sections";

/**
 * One collapsible section of the tab: a header that is always visible —
 * chevron, name, a count, whatever else the owner puts beside it — and the
 * body under it while open. A section is as tall as its content until the
 * open ones overflow the tab; then they split its height equally, each
 * scrolling its own list (CSS, `.git__sections`) — the list inside the
 * body is the scroll container, so a windowed list measures its own
 * viewport. Dumb on purpose:
 * whether it is open is the owner's state, what it counts is the owner's
 * view model.
 */
export function Section({
  id,
  label,
  count,
  open,
  onToggle,
  aside,
  children,
}: {
  id: SectionId;
  label: string;
  /** Printed as a pill; nothing while null. */
  count: number | null;
  open: boolean;
  onToggle: (id: SectionId) => void;
  /** Extra header content between the name and the count. */
  aside?: ReactNode;
  children?: ReactNode;
}) {
  const bodyId = `git-sec-${id}`;
  return (
    <section className={`git__sec${open ? " git__sec--open" : ""}`}>
      <button
        type="button"
        className="git__sechdr"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => onToggle(id)}
      >
        {/* One drawn mark, turned by CSS when open — the workspace rail's
            chevron, not two glyphs swapping. */}
        <span className="git__chev" aria-hidden>
          <ChevronIcon />
        </span>
        <span className="git__secname">{label}</span>
        {aside}
        {count !== null && <span className="git__count">{count}</span>}
      </button>
      {open && (
        <div className="git__secbody" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  );
}
