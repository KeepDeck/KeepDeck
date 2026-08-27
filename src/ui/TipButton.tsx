/**
 * A button that explains itself on hover — in the app's own tip, not the
 * browser's.
 *
 * The deck bar is a row of icons, and an icon that cannot say what it does is
 * a guess. Every control there carried a `title`, and none of them showed
 * anything: this WKWebView does not draw native tooltips. The app already
 * knew that in principle — it renders its own UI for every interaction and
 * suppresses the WebView's own chrome wholesale (see `contextMenu.ts`) — but
 * `title` kept being written as if it worked.
 *
 * Host-only on purpose, and that is why it lives here rather than in the kit
 * beside `Button`: the tip's placement, its single-open-at-a-time rule and
 * its portal are the host's, and a built-in plugin bundling the kit must not
 * drag them in. So the kit owns what a button IS, and this owns how one
 * explains itself.
 *
 * `title` is deliberately NOT forwarded. Two tips over one control — ours and
 * the browser's — is the failure this exists to avoid, and on a platform that
 * did draw the native one it would be visible immediately.
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
