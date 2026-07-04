import { useState } from "react";
import type { RunPreset } from "../../domain/runPresets";
import { noAutoCorrect } from "../../ui/inputProps";
import { useEscape } from "../../ui/useEscape";
import { CloseIcon, PlayIcon } from "../../ui/icons";

interface RunPresetPickerProps {
  /** The workspace's saved presets; clicking one runs it immediately. */
  presets: RunPreset[];
  onPick(preset: RunPreset): void;
  /** Run an ad-hoc command line; `saveAs` (a name, possibly blank) also saves
   * it as a preset first, `null` runs it without saving (Zed-style: config
   * is optional, not an entry fee). */
  onAdHoc(command: string, saveAs: string | null): void;
  onDelete(presetId: string): void;
  onCancel(): void;
}

/**
 * The ▶ picker: run a saved preset, or type a command — in the worktree of
 * the pane whose header opened it. Presets belong to the workspace; deleting
 * one here edits the workspace config, not any running pane.
 */
export function RunPresetPicker({
  presets,
  onPick,
  onAdHoc,
  onDelete,
  onCancel,
}: RunPresetPickerProps) {
  const [command, setCommand] = useState("");
  const [save, setSave] = useState(false);
  const [name, setName] = useState("");

  useEscape(onCancel);

  const runAdHoc = () => {
    const line = command.trim();
    if (line) onAdHoc(line, save ? name : null);
  };

  return (
    <form
      className="form run"
      onSubmit={(e) => {
        e.preventDefault();
        runAdHoc();
      }}
    >
      <h2 className="form__title">Run</h2>

      {presets.length > 0 && (
        <>
          <span className="form__label">Presets</span>
          <ul className="run__presets">
            {presets.map((p) => (
              <li key={p.id} className="run__preset">
                <button
                  type="button"
                  className="run__preset-run"
                  onClick={() => onPick(p)}
                  title={`Run: ${p.command}`}
                >
                  <PlayIcon />
                  <span className="run__preset-text">
                    <span className="run__preset-name">{p.name}</span>
                    <span className="run__preset-command">{p.command}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="run__preset-delete"
                  onClick={() => onDelete(p.id)}
                  title={`Delete preset "${p.name}"`}
                  aria-label={`Delete preset ${p.name}`}
                >
                  <CloseIcon />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <span className="form__label">Command</span>
      <textarea
        {...noAutoCorrect}
        className="form__input run__command"
        value={command}
        autoFocus
        rows={3}
        onChange={(e) => setCommand(e.target.value)}
        onKeyDown={(e) => {
          // Enter inserts a newline (multi-line commands are legitimate
          // shell); ⌘/Ctrl+Enter runs.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            runAdHoc();
          }
        }}
        placeholder={"e.g. pnpm dev — $KEEPDECK_PORT is yours to use\n⌘⏎ runs"}
        aria-label="Command to run"
      />

      <label className="run__save">
        <input
          type="checkbox"
          checked={save}
          onChange={(e) => setSave(e.target.checked)}
        />
        <span>Save as preset</span>
      </label>
      {save && (
        <input
          {...noAutoCorrect}
          className="form__input run__save-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Preset name (optional)"
          aria-label="Preset name"
        />
      )}

      <div className="form__actions">
        <button type="button" className="form__cancel" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="form__create"
          disabled={!command.trim()}
          title={command.trim() ? "Run the command" : "Type a command first"}
        >
          Run
        </button>
      </div>
    </form>
  );
}
