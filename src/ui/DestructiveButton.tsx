import type { ButtonHTMLAttributes } from "react";

/**
 * A button for destructive, irreversible actions — closing an agent/workspace,
 * deleting, discarding. Styled red so it never reads as the "safe" or
 * recommended choice (unlike the green primary), and it's deliberately not the
 * default focus in a confirm prompt. Reuse it everywhere a click tears
 * something down, so destructive affordances stay visually consistent.
 *
 * Forwards all native button props (onClick, autoFocus, disabled, aria-*, …);
 * `type` defaults to "button" so it never submits an enclosing form.
 */
export function DestructiveButton({
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      type={type}
      className={`btn-destructive${className ? ` ${className}` : ""}`}
    />
  );
}
