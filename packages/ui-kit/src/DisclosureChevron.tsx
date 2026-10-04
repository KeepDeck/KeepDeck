import { ChevronIcon } from "./icons";

/**
 * The mark of a thing that opens — ONE chevron, pointing right while shut
 * and turned down while open, the turn eased (the host's .kd-chevron).
 * The house pattern for every disclosure: the strip's team lists, a
 * plugin's sections, the tracker's groups and its activity. Its owner
 * keeps the semantics (`aria-expanded` on its own control); this is the
 * picture, kept from assistive tech.
 */
export function DisclosureChevron({ open }: { open: boolean }) {
  return (
    <span className={open ? "kd-chevron kd-chevron--open" : "kd-chevron"} aria-hidden>
      <ChevronIcon />
    </span>
  );
}
