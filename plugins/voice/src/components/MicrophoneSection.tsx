import type { CustomSettingsFieldProps } from "@keepdeck/plugin-api";
import { Button } from "@keepdeck/ui-kit/Button";
import { Dropdown } from "@keepdeck/ui-kit/Dropdown";
import { MIC_KEY, micPicker, readMicPick } from "../microphone";
import { runtime } from "../runtime";
import { useMicDevices } from "./useMicDevices";

/** The microphone picker in the plugin's settings: which input voice records
 * from. Renders the picker the `micPicker` view model describes. */
export function MicrophoneSection({ values, write }: CustomSettingsFieldProps) {
  const { ctx } = runtime();
  const { devices, error, refresh } = useMicDevices(ctx);
  const picker = micPicker(devices, readMicPick(values));
  return (
    <div className="voice-mic">
      <div className="voice-mic__row">
        <Dropdown
          className="voice-mic__picker"
          options={picker.options}
          value={picker.value}
          onChange={(value) => write(MIC_KEY, picker.pickOf(value))}
          ariaLabel="Microphone"
        />
        <Button size="sm" onClick={refresh}>
          Refresh
        </Button>
      </div>
      {error && <div className="voice-mic__error kd-selectable">{error}</div>}
    </div>
  );
}
