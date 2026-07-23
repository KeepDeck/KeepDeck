interface YoloFieldProps {
  /** The toggle's current position — owned by the rendering dialog. */
  checked: boolean;
  /** Flip the toggle; the dialog holds the state. */
  onChange(checked: boolean): void;
}

/**
 * The YOLO opt-in checkbox with its warning-tinted label. Purely
 * presentational — the owning dialog decides WHETHER to render it at all
 * (gated on the selected agent's declared YOLO capability, the single
 * domain gate in `agentSupportsYolo`) and owns the checked state. One
 * anatomy shared by every spawn surface (the "+ Agent" dialog, the fork
 * dialog), so the hazard reads identically wherever an agent is born.
 */
export function YoloField({ checked, onChange }: YoloFieldProps) {
  return (
    <label className="form__yolo">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="form__yolo-text">
        YOLO mode
        <span className="form__yolo-hint">
          Runs without permission prompts — the agent acts on its own
        </span>
      </span>
    </label>
  );
}
