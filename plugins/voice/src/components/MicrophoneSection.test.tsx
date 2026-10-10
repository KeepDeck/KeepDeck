// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIC_KEY } from "../microphone";
import { clearRuntime, setRuntime, type VoiceRuntime } from "../runtime";
import { MicrophoneSection } from "./MicrophoneSection";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PM700 = { id: "coreaudio:usb-pm700", name: "BY-PM700", isDefault: true };
const BUILTIN = { id: "coreaudio:BuiltInMicrophoneDevice", name: "MacBook Pro Microphone", isDefault: false };

describe("MicrophoneSection", () => {
  let stage: HTMLElement;
  let root: Root;
  const write = vi.fn();
  const devices = vi.fn(async () => [PM700, BUILTIN]);

  async function render(values: Record<string, unknown>) {
    await act(async () => root.render(createElement(MicrophoneSection, { values, write })));
  }

  beforeEach(() => {
    write.mockClear();
    devices.mockClear();
    setRuntime({ ctx: { services: { speech: { devices } } } } as unknown as VoiceRuntime);
    stage = document.body.appendChild(document.createElement("div"));
    root = createRoot(stage);
  });

  afterEach(() => {
    act(() => root.unmount());
    stage.remove();
    clearRuntime();
  });

  it("reads the microphones when it opens, and shows the default by name", async () => {
    await render({});
    expect(devices).toHaveBeenCalledOnce();
    expect(stage.textContent).toContain("System default (BY-PM700)");
  });

  it("reads them again on Refresh — and only then", async () => {
    await render({});
    const refresh = [...stage.querySelectorAll("button")].find((b) => b.textContent === "Refresh")!;
    await act(async () => refresh.click());
    expect(devices).toHaveBeenCalledTimes(2);
  });

  it("shows an unplugged pick as not connected, still selected", async () => {
    devices.mockResolvedValueOnce([BUILTIN]);
    await render({ [MIC_KEY]: { id: PM700.id, name: "BY-PM700" } });
    expect(stage.textContent).toContain("BY-PM700 — not connected");
  });

  it("writes the chosen device by id and name", async () => {
    await render({});
    const trigger = stage.querySelector("button")!;
    await act(async () => trigger.click());
    const option = [...document.querySelectorAll('[role="option"]')].find(
      (o) => o.textContent === "MacBook Pro Microphone",
    ) as HTMLElement;
    await act(async () => option.click());
    expect(write).toHaveBeenCalledWith(MIC_KEY, { id: BUILTIN.id, name: BUILTIN.name });
  });
});
