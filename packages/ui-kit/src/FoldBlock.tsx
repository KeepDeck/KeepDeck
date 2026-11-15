import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { easeFold } from "./foldMotion";
import { FOLD_MOTION_MS, reducedMotion } from "./useFoldMotion";

/**
 * A short list's fold, where no VirtualList is: the rows under a heading
 * unroll from under it as it opens and roll back up into it as it shuts —
 * the tracker's fold, on its clock and curve (FOLD_MOTION_MS, easeFold),
 * for a list too short to window (Statistics' Breakdown).
 *
 * The rows are the owner's. Open, it draws what it is given; shut, it draws
 * the rows it was last given until they have rolled up — inert, as the
 * tracker's leaving rows are — so the owner may stop listing them the
 * moment it shuts. A fold turned round midway goes on from the height it
 * reached. Its height is written only while it moves; at rest it is the
 * rows' own. The first draw never moves, and under reduced motion every
 * fold lands at once.
 */
export function FoldBlock({
  open,
  role,
  className,
  children,
}: {
  open: boolean;
  /** Its place in the owner's structure — a table's `rowgroup`. */
  role?: string;
  className?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  // The rows last given while open: what rolls up as it shuts.
  const given = useRef<ReactNode>(children);
  if (open) given.current = children;
  // Whether shut rows are still rolling up — settled in the render that
  // shuts it, so that render already draws them.
  const [fold, setFold] = useState({ open, rolling: false });
  if (fold.open !== open) setFold({ open, rolling: !open && !reducedMotion() });
  // The height drawn while it moves — where a fold turned round goes on
  // from; null at rest.
  const drawn = useRef<number | null>(null);
  // The `open` the motion last answered: the first draw (and a strict
  // re-run of it) answers nothing.
  const answered = useRef(open);

  useLayoutEffect(() => {
    const block = box.current;
    if (block === null || answered.current === open) return;
    answered.current = open;
    const rest = () => {
      drawn.current = null;
      block.style.height = "";
      block.style.overflow = "";
    };
    if (reducedMotion()) {
      rest();
      return;
    }
    const from = drawn.current ?? (open ? 0 : block.scrollHeight);
    const to = open ? block.scrollHeight : 0;
    const paint = (height: number) => {
      drawn.current = height;
      block.style.height = `${height}px`;
    };
    block.style.overflow = "hidden";
    paint(from);
    let startedAt: number | null = null;
    let frame = requestAnimationFrame(function tick(time) {
      startedAt ??= time;
      const progress = easeFold((time - startedAt) / FOLD_MOTION_MS);
      paint(from + (to - from) * progress);
      if (progress < 1) {
        frame = requestAnimationFrame(tick);
        return;
      }
      rest();
      if (!open) setFold((now) => ({ ...now, rolling: false }));
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const rolling = !open && fold.rolling;
  return (
    <div ref={box} role={role} className={className} inert={rolling || undefined}>
      {open ? children : rolling ? given.current : null}
    </div>
  );
}
