import { useState } from "react";
import { updateSettings } from "../../app/settingsManager";
import { useSettings } from "../../app/useSettings";
import {
  DEFAULT_SETTINGS,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  clampScrollback,
} from "../../domain/settings";

/**
 * Terminal preferences: scrollback ([F6]). The field commits on blur/Enter,
 * not per keystroke — clamping while the user is still typing would fight
 * the input. The dialog keeps hidden sections mounted, so an uncommitted
 * draft survives switching sections and dies with the dialog.
 */
export function TerminalSection() {
  const scrollback = useSettings()?.scrollback ?? DEFAULT_SETTINGS.scrollback;
  const [draft, setDraft] = useState(String(scrollback));

  const commit = () => {
    const parsed = Number(draft);
    // A number input surfaces rejected garbage as "" — and Number("") is 0,
    // so the emptiness check must come first or garbage would commit the min.
    if (draft.trim() === "" || !Number.isFinite(parsed)) {
      // Nothing usable — revert to the live value instead of guessing.
      setDraft(String(scrollback));
      return;
    }
    const clamped = clampScrollback(parsed);
    setDraft(String(clamped));
    if (clamped !== scrollback) updateSettings({ scrollback: clamped });
  };

  return (
    <>
      <span className="form__label">Terminal scrollback</span>
      <input
        className="form__input settings__number"
        type="number"
        min={SCROLLBACK_MIN}
        max={SCROLLBACK_MAX}
        step={1000}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
        aria-label="Terminal scrollback lines"
      />
      <span className="settings__hint">
        Lines kept per pane · applies to open terminals
      </span>
    </>
  );
}
