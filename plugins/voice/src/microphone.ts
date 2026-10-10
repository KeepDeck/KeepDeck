import type { SpeechDevice, SpeechStartOptions } from "@keepdeck/plugin-api";

/**
 * The microphone choice: which input the user picked, kept in the plugin's
 * settings values by the device's stable id plus the name it had, so a pick
 * whose device is unplugged can still be shown by name (decision №2). No
 * pick = the system default.
 */
export const MIC_KEY = "microphone";

export interface MicPick {
  id: string;
  name: string;
}

/** The stored pick, or null for "system default" (absent or malformed). */
export function readMicPick(values: Record<string, unknown>): MicPick | null {
  const value = values[MIC_KEY];
  if (typeof value !== "object" || value === null) return null;
  const { id, name } = value as Record<string, unknown>;
  return typeof id === "string" && id !== "" && typeof name === "string" ? { id, name } : null;
}

/** What a capture is asked to open for this pick. */
export function startOptionsFor(pick: MicPick | null): SpeechStartOptions {
  return pick ? { deviceId: pick.id } : {};
}

/** One row of the picker. */
export interface MicChoice {
  /** The value written back when chosen: null = system default. */
  pick: MicPick | null;
  label: string;
  selected: boolean;
  /** The picked device is not connected right now. */
  missing: boolean;
}

/**
 * The picker's rows: "System default" (naming what that is now), then every
 * connected device, then — if the pick is not connected — the pick itself,
 * marked, so the choice stays visible and kept until the device is back
 * (decision №3).
 */
export function micChoices(devices: readonly SpeechDevice[], pick: MicPick | null): MicChoice[] {
  const current = devices.find((d) => d.isDefault);
  const rows: MicChoice[] = [
    {
      pick: null,
      label: current ? `System default (${current.name})` : "System default",
      selected: pick === null,
      missing: false,
    },
    ...devices.map((d) => ({
      pick: { id: d.id, name: d.name },
      label: d.name,
      selected: pick?.id === d.id,
      missing: false,
    })),
  ];
  if (pick && !devices.some((d) => d.id === pick.id)) {
    rows.push({ pick, label: `${pick.name} — not connected`, selected: true, missing: true });
  }
  return rows;
}

/** The picker's value for "system default" — no device id can be empty. */
export const DEFAULT_CHOICE = "";

/** The picker as a dropdown: options keyed by device id, the selected key,
 * and what each key writes back. */
export interface MicPicker {
  options: { value: string; label: string }[];
  value: string;
  pickOf(value: string): MicPick | null;
}

export function micPicker(devices: readonly SpeechDevice[], pick: MicPick | null): MicPicker {
  const rows = micChoices(devices, pick);
  const keyOf = (row: MicChoice) => row.pick?.id ?? DEFAULT_CHOICE;
  return {
    options: rows.map((row) => ({ value: keyOf(row), label: row.label })),
    value: keyOf(rows.find((row) => row.selected) ?? rows[0]),
    pickOf: (value) => rows.find((row) => keyOf(row) === value)?.pick ?? null,
  };
}
