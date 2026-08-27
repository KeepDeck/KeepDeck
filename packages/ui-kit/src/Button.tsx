/**
 * The button — one control, three priorities.
 *
 * The app had none. It had `CloseButton` and `DestructiveButton`, two special
 * cases, and 106 hand-written `<button>` elements around them, each carrying
 * its own class, its own padding and its own idea of what `disabled` looks
 * like (opacity .4, .45, .5, .55 — and, in the deck bar, no rule at all, so a
 * refused control looked exactly like an available one). That is what "no
 * obligatory system" costs: not ugliness, but surfaces that cannot be
 * compared because nothing about them is stated once.
 *
 * WHAT A VARIANT MEANS: the priority of the action, not its colour.
 *   primary   — the one affirmative act of the surface. At most one.
 *   secondary — its quiet neighbours: real actions that must not compete.
 *   ghost     — chrome that should disappear until reached for.
 * Choosing by priority is what makes a screen readable at a glance; choosing
 * by appearance is how it stops being.
 *
 * WHAT THIS IS NOT: the census that prompted it found nine visual archetypes
 * across the app, and only these three are buttons. A segmented choice, a tab,
 * a list row and a selectable card carry selection and layout meaning — they
 * are different controls that happen to be built from `<button>`, and folding
 * them in here would smear four contracts into one. They get their own
 * primitives or none.
 *
 * The classNames are the host stylesheet's to dress, per this package's rule:
 * ui-kit is shared chrome, styled once by the app for every consumer.
 */
import type { ReactNode } from "react";

/** The priority of the action, which is what picks the appearance. */
export type ButtonVariant = "primary" | "secondary" | "ghost";

/** Row height, not importance: `sm` fits a 36px strip, `md` a dialog. */
export type ButtonSize = "sm" | "md";

export interface ButtonProps {
  /** Defaults to `secondary` — the safe answer, and the one that forces a
   *  deliberate choice to promote something to `primary`. */
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Native tooltip. Free to change with state — a toggle's does. */
  title?: string;
  /** Accessible name. Defaults to `title`, and is passed separately exactly
   *  when the two must differ: an icon-only toggle's tooltip says what
   *  pressing it will DO, while its name has to keep saying what it IS. */
  label?: string;
  disabled?: boolean;
  onClick(): void;
  /** One extra class for a caller that owns a genuine one-off — a positioned
   *  anchor, a grid cell. Not a way to restyle the button. */
  className?: string;
  children: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "md",
  title,
  label,
  disabled,
  onClick,
  className,
  children,
}: ButtonProps) {
  const classes = ["kd-btn", `kd-btn--${variant}`];
  if (size === "sm") classes.push("kd-btn--sm");
  if (className) classes.push(className);
  return (
    <button
      type="button"
      className={classes.join(" ")}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={label ?? title}
    >
      {children}
    </button>
  );
}
