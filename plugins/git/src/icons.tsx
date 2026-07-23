/**
 * Git-tab stroke icons, on the SAME 24-unit grid as `@keepdeck/ui-kit`'s set
 * (drawn in the current text color, decorative/`aria-hidden`) so the tab reads
 * as native chrome. Kept local rather than pushed into ui-kit: only this
 * plugin needs them today.
 */

const iconProps = {
  viewBox: "0 0 24 24",
  width: 13,
  height: 13,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** A branch fork (Lucide `git-branch`, ISC). */
export function BranchIcon() {
  return (
    <svg {...iconProps}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

/** The checked-out marker in the branch picker (Lucide `check`, ISC). */
export function CheckIcon() {
  return (
    <svg {...iconProps}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
