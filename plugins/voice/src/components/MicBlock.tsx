import { Button } from "@keepdeck/ui-kit/Button";
import { Dropdown } from "@keepdeck/ui-kit/Dropdown";
import type { MicPicker } from "../microphone";
import type { MicStatus } from "../micStatus";

/** The meter bar: a fill the status computed. */
export function MicMeter({ status, className }: { status: MicStatus; className: string }) {
  return (
    <span className={className}>
      <span className={`${className}-fill`} style={{ width: `${status.meter}%` }} />
    </span>
  );
}

/** The Voice tab's microphone block: the picker (what to record from), its
 * level while listening, and what is wrong with it — everything as
 * `micPicker` and `micStatus` decided. */
export function MicBlock({
  status,
  picker,
  listening,
  listError,
  standIn,
  onChoose,
  onRefresh,
}: {
  status: MicStatus;
  picker: MicPicker;
  listening: boolean;
  listError: string | null;
  standIn: string | null;
  onChoose(value: string): void;
  onRefresh(): void;
}) {
  return (
    <div className="voice-micblock">
      <div className="voice-micblock__row">
        <Dropdown
          className="voice-micblock__picker"
          size="sm"
          options={picker.options}
          value={picker.value}
          onChange={onChoose}
          ariaLabel="Microphone"
        />
        <Button size="sm" onClick={onRefresh} title="Read the connected microphones again">
          Refresh
        </Button>
        {listening && <MicMeter status={status} className="voice__meter" />}
      </div>
      {standIn && <div className="voice-micblock__standin">{standIn}</div>}
      {listError && <div className="voice-micblock__error kd-selectable">{listError}</div>}
      {status.warnings.map((w) => (
        <div key={w.kind} className={`voice-micblock__warning voice-micblock__warning--${w.kind}`}>
          {w.text}
        </div>
      ))}
    </div>
  );
}
