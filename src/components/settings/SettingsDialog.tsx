import { useState } from "react";
import { selectableAgents, type AgentInfo } from "../../domain/agents";
import {
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  clampScrollback,
  type Settings,
} from "../../domain/settings";
import { ModalOverlay } from "../../ui/ModalOverlay";
import { useEscape } from "../../ui/useEscape";

interface SettingsDialogProps {
  settings: Settings;
  /** Agent catalog for the default-agent picker ([F1]). */
  agents: AgentInfo[];
  /** Apply a change — every control writes through instantly ([F6]). */
  onChange(patch: Partial<Settings>): void;
  onClose(): void;
}

/**
 * Global settings ([F6]) — an in-app modal (no system windows). Controls
 * apply instantly through `onChange`; Done/Esc only dismiss. The scrollback
 * field commits on blur/Enter, not per keystroke — clamping while the user
 * is still typing would fight the input.
 */
export function SettingsDialog({
  settings,
  agents,
  onChange,
  onClose,
}: SettingsDialogProps) {
  useEscape(onClose);
  const agentOptions = selectableAgents(agents);
  const [scrollbackDraft, setScrollbackDraft] = useState(
    String(settings.scrollback),
  );

  const commitScrollback = () => {
    const parsed = Number(scrollbackDraft);
    // A number input surfaces rejected garbage as "" — and Number("") is 0,
    // so the emptiness check must come first or garbage would commit the min.
    if (scrollbackDraft.trim() === "" || !Number.isFinite(parsed)) {
      // Nothing usable — revert to the live value instead of guessing.
      setScrollbackDraft(String(settings.scrollback));
      return;
    }
    const clamped = clampScrollback(parsed);
    setScrollbackDraft(String(clamped));
    if (clamped !== settings.scrollback) onChange({ scrollback: clamped });
  };

  return (
    <ModalOverlay>
      <div
        className="form settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <h2 className="form__title">Settings</h2>

        <span className="form__label">Default agent</span>
        <div className="form__types">
          <button
            type="button"
            className={`form__type${settings.defaultAgent === null ? " form__type--active" : ""}`}
            onClick={() => onChange({ defaultAgent: null })}
            title="Preselect the first installed agent"
          >
            Auto
          </button>
          {agentOptions.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`form__type${a.id === settings.defaultAgent ? " form__type--active" : ""}`}
              onClick={() => onChange({ defaultAgent: a.id })}
            >
              {a.label}
            </button>
          ))}
        </div>
        <span className="settings__hint">
          Preselected when creating workspaces and agents
        </span>

        <span className="form__label">Terminal scrollback</span>
        <input
          className="form__input settings__number"
          type="number"
          min={SCROLLBACK_MIN}
          max={SCROLLBACK_MAX}
          step={1000}
          value={scrollbackDraft}
          onChange={(e) => setScrollbackDraft(e.target.value)}
          onBlur={commitScrollback}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitScrollback();
          }}
          aria-label="Terminal scrollback lines"
        />
        <span className="settings__hint">
          Lines kept per pane · applies to open terminals
        </span>

        <label className="confirm__option settings__option">
          <input
            type="checkbox"
            checked={settings.confirmBeforeClose}
            onChange={(e) => onChange({ confirmBeforeClose: e.target.checked })}
          />
          <span className="confirm__option-text">
            Confirm before closing an agent or workspace
            <span className="confirm__option-note">
              When off, closing never deletes worktrees
            </span>
          </span>
        </label>

        <div className="confirm__actions">
          <button type="button" className="form__create" onClick={onClose} autoFocus>
            Done
          </button>
        </div>
      </div>
    </ModalOverlay>
  );
}
