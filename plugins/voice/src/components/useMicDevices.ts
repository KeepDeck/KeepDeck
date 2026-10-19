import { useCallback, useEffect, useState } from "react";
import type { PluginContext, SpeechDevice } from "@keepdeck/plugin-api";
import { errorMessage } from "@keepdeck/plugin-api";

/** The connected microphones, read when the picker mounts and on `refresh`
 * (decision №1: on request — nothing watches in the background). */
export function useMicDevices(ctx: PluginContext): {
  devices: SpeechDevice[];
  error: string | null;
  refresh(): void;
} {
  const [devices, setDevices] = useState<SpeechDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => {
    ctx.services.speech
      .devices()
      .then((list) => {
        setDevices(list);
        setError(null);
      })
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [ctx]);
  useEffect(refresh, [refresh]);
  return { devices, error, refresh };
}
