/**
 * A button that explains itself on hover — in the app's own tip, not the
 * browser's.
 *
 * The deck bar is a row of icons, and an icon that cannot say what it does is
 * a guess. A `title` does get a native tooltip in this WebView — checked in
 * the running app on 2026-10-01 (the pane header's bolt, status dot and
 * window controls all show theirs) — but only after the system's long hover
 * delay, in the system's look, and with nothing the app controls. A toolbar
 * whose icons are the only way to read it wants the app's own tip: its hover
 * intent, its placement, one open at a time. An earlier version of this
 * comment said the WebView drew no native tooltip at all; that was wrong,
 * and other comments repeated it.
 *
 * Host-only on purpose, and that is why it lives here rather than in the kit
 * beside `Button`: the tip's placement, its single-open-at-a-time rule and
 * its portal are the host's, and a built-in plugin bundling the kit must not
 * drag them in. So the kit owns what a button IS, and this owns how one
 * explains itself.
 *
 * `title` is deliberately NOT forwarded. Two tips over one control — ours and
 * the browser's — is the failure this exists to avoid, and since the native
 * one does draw here, forwarding it would show both.
 */
import type { ReactNode } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "./Button";
import { Tooltip } from "./Tooltip";

/** Hover intent before the tip opens.
 *
 * A toolbar is swept by the pointer on its way somewhere else, and a tip that
 * opens instantly turns that sweep into a flicker of cards. Long enough to
 * mean "I stopped here", short enough that stopping feels answered. */
export const BAR_TIP_DELAY_MS = 400;

export interface TipButtonProps {
  /** What the control does, said in full — this is the visible answer, so it
   *  may be a sentence rather than a label. */
  tip: string;
  /** Accessible name. Defaults to the tip, and is passed separately when the
   *  tip changes with state while the name must not: a toggle's tip says what
   *  pressing it will DO, its name says what it IS. */
  label?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  onClick(): void;
  delayMs?: number;
  children: ReactNode;
}

export function TipButton({
  tip,
  label,
  variant,
  size,
  disabled,
  onClick,
  delayMs = BAR_TIP_DELAY_MS,
  children,
}: TipButtonProps) {
  return (
    <Tooltip tip={tip} delayMs={delayMs}>
      <Button
        variant={variant}
        size={size}
        label={label ?? tip}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </Button>
    </Tooltip>
  );
}
