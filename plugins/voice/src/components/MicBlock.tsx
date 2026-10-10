import type { MicStatus } from "../micStatus";

/** The meter bar: a fill the status computed. */
export function MicMeter({ status, className }: { status: MicStatus; className: string }) {
  return (
    <span className={className}>
      <span className={`${className}-fill`} style={{ width: `${status.meter}%` }} />
    </span>
  );
}

/** The Voice tab's microphone block: which device, its level, and what is
 * wrong with it — everything as `micStatus` decided. */
export function MicBlock({ status, listening }: { status: MicStatus; listening: boolean }) {
  if (!status.device && status.warnings.length === 0) return null;
  return (
    <div className="voice-micblock">
      {status.device && (
        <div className="voice-micblock__row">
          <span className="voice-micblock__device">🎙 {status.device}</span>
          {listening && <MicMeter status={status} className="voice__meter" />}
        </div>
      )}
      {status.warnings.map((w) => (
        <div key={w.kind} className={`voice-micblock__warning voice-micblock__warning--${w.kind}`}>
          {w.text}
        </div>
      ))}
    </div>
  );
}
