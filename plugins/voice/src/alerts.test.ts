import { describe, expect, it, vi } from "vitest";
import { createVoiceAlerts } from "./alerts";
import type { VoiceProblem } from "./problems";
import { problemWords, type ProblemWords } from "./problemWords";

const present = (...problems: VoiceProblem[]) =>
  new Map<VoiceProblem, ProblemWords>(problems.map((p) => [p, problemWords(p)]));
const SCOPE: VoiceProblem[] = ["mic-missing", "no-device"];

describe("createVoiceAlerts", () => {
  it("announces a problem once, under its own tag, pointing at the Voice tab", () => {
    const notify = vi.fn();
    createVoiceAlerts(notify).update(SCOPE, present("mic-missing"));
    expect(notify).toHaveBeenCalledWith({
      title: "Microphone not connected",
      body: undefined,
      severity: "warning",
      tag: "mic-missing",
      dockTab: "voice",
    });
  });

  it("stays quiet while the problem persists — no spam", () => {
    const notify = vi.fn();
    const alerts = createVoiceAlerts(notify);
    for (let i = 0; i < 5; i++) alerts.update(SCOPE, present("mic-missing"));
    expect(notify).toHaveBeenCalledOnce();
  });

  it("announces again only after a step showed it gone", () => {
    const notify = vi.fn();
    const alerts = createVoiceAlerts(notify);
    alerts.update(SCOPE, present("mic-missing"));
    alerts.update(SCOPE, present());
    alerts.update(SCOPE, present("mic-missing"));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("a step outside a problem's scope neither clears nor raises it", () => {
    const notify = vi.fn();
    const alerts = createVoiceAlerts(notify);
    alerts.update(SCOPE, present("mic-missing"));
    alerts.update(["clipping"], present());
    alerts.update(SCOPE, present("mic-missing"));
    expect(notify).toHaveBeenCalledOnce();
  });
});
