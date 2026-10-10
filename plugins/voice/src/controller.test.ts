import { describe, expect, it, vi } from "vitest";
import type { PluginContext, SpeechTranscript } from "@keepdeck/plugin-api";
import {
  createFakeHost,
  fakeManifest,
  type FakeHost,
} from "../../../packages/plugin-guest/src/fakeHost";
import { createVoiceController, MODEL_KEY } from "./controller";
import { MIC_KEY } from "./microphone";
import { MODEL_CATALOG, type VoiceModelInfo } from "./modelCatalog";
import { speechTranscript, speechCapture } from "@keepdeck/plugin-api/testing";

const installedModels = async (): Promise<VoiceModelInfo[]> =>
  MODEL_CATALOG.map((model) => ({ ...model, installed: true }));

/** A host holding persisted plugin values, with the model field declared just
 * as `activate` declares it: a plugin is handed a stored value only through a
 * registered section, and only under a key that section names — so a test
 * exercising the persisted pick has to declare it too, or it proves nothing. */
function hostWithSettings(settingsValues: Record<string, unknown>): FakeHost {
  const host = createFakeHost({
    manifest: fakeManifest("keepdeck.voice"),
    settingsValues,
  });
  host.ctx.settings.registerSection({
    label: "Voice",
    fields: [
      { kind: "custom", key: MODEL_KEY, Component: () => null },
      { kind: "custom", key: MIC_KEY, Component: () => null },
    ],
  });
  return host;
}

/** A fake host whose speech service yields scripted transcripts and whose
 * command results are primeable — the controller under real wiring. */
function setup(transcript: SpeechTranscript, now: () => number = () => 42) {
  const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
  const cancelCapture = vi.fn(async () => {});
  const stopCapture = vi.fn(async () => transcript);
  let onLevel: ((rms: number) => void) | undefined;
  const ctx: PluginContext = {
    ...host.ctx,
    services: {
      ...host.ctx.services,
      speech: {
        ...host.ctx.services.speech,
        startCapture: vi.fn(async (cb) => {
          onLevel = cb;
          return speechCapture({ stop: stopCapture, cancel: cancelCapture });
        }),
      },
    },
  };
  host.commandResults.set("workspace.list", {
    ok: true,
    value: [
      {
        id: "ws-1",
        name: "KeepDeck",
        active: true,
        panes: [{ id: "p1", title: "Claude 1" }],
      },
      {
        id: "ws-2",
        name: "Website",
        active: false,
        panes: [],
      },
    ],
  });
  host.commandResults.set("pane.target", {
    ok: true,
    value: { workspaceId: "ws-1", paneId: "p1" },
  });
  const controller = createVoiceController(ctx, now, installedModels);
  return {
    host,
    controller,
    cancelCapture,
    stopCapture,
    level: () => onLevel,
  };
}

// History is NEWEST-FIRST, so a multi-step utterance reads bottom-up here:
// the last thing that happened is index 0.
const texts = (c: ReturnType<typeof createVoiceController>) =>
  c.snapshot().history.map((e) => [e.tone, e.text]);

describe("createVoiceController", () => {
  it("runs a spoken command end to end: heard → resolved → executed", async () => {
    const { host, controller } = setup(speechTranscript({ text: "Create a lead in keep deck with task fix the header." }));
    await controller.start("command");
    expect(controller.snapshot().phase).toBe("listening");
    await controller.stop();

    expect(host.executedCommands).toEqual([
      { id: "workspace.list", args: {} },
      { id: "workspace.list", args: {} },
      {
        id: "agent.spawn",
        args: { workspace: "ws-1", role: "lead", task: "fix the header" },
      },
    ]);
    expect(texts(controller)).toEqual([
      ["done", "agent spawned, task queued"],
      ["heard", "Create a lead in keep deck with task fix the header."],
    ]);
    expect(controller.snapshot().phase).toBe("idle");
  });

  it("reads the persisted model pick from the plugin's settings values", async () => {
    const stop = vi.fn(async () => speechTranscript({ text: "close", seconds: 1, level: 0.1 }));
    const host = hostWithSettings({ model: "whisper-small-q5_1" });
    const ctx: PluginContext = {
      ...host.ctx,
      services: {
        ...host.ctx.services,
        speech: {
          ...host.ctx.services.speech,
          startCapture: vi.fn(async () => speechCapture({
            stop,
            cancel: vi.fn(async () => {}),
          })),
        },
      },
    };
    host.commandResults.set("workspace.list", { ok: true, value: [] });
    const controller = createVoiceController(ctx, () => 42, installedModels);
    await controller.start("command");
    await controller.stop();
    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: "whisper",
        modelPath: "models/ggml-small-q5_1.bin",
      }),
    );
  });

  it("dictation types the transcript into the focused pane without submitting", async () => {
    const { host, controller } = setup(speechTranscript({ text: "please refactor the parser" }));
    await controller.start("dictation");
    await controller.stop();

    expect(host.executedCommands).toEqual([
      { id: "pane.target", args: {} },
      { id: "workspace.list", args: {} },
      {
        id: "pane.write",
        args: {
          workspace: "ws-1",
          agent: "p1",
          text: "please refactor the parser",
          mode: "type",
          focusInput: true,
        },
      },
    ]);
    expect(texts(controller)).toEqual([
      ["done", "typed into the input"],
      ["heard", "please refactor the parser"],
    ]);
  });

  it("pins the selected pane while transcription is in flight", async () => {
    const { host, controller, stopCapture } = setup(speechTranscript({ text: "pinned transcript" }));
    let finishTranscript!: (value: SpeechTranscript) => void;
    stopCapture.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishTranscript = resolve;
        }),
    );
    await controller.start("dictation");
    const stopping = controller.stop();
    await vi.waitFor(() => expect(stopCapture).toHaveBeenCalledOnce());

    host.commandResults.set("pane.target", {
      ok: true,
      value: { workspaceId: "ws-1", paneId: "p2" },
    });
    finishTranscript(speechTranscript({ text: "pinned transcript", seconds: 1, level: 0.1 }));
    await stopping;

    expect(host.executedCommands[host.executedCommands.length - 1]).toEqual({
      id: "pane.write",
      args: {
        workspace: "ws-1",
        agent: "p1",
        text: "pinned transcript",
        mode: "type",
        focusInput: true,
      },
    });
  });

  it("waits for the initial model scan before selecting an engine", async () => {
    let release!: (models: VoiceModelInfo[]) => void;
    const ready = new Promise<VoiceModelInfo[]>((resolve) => {
      release = resolve;
    });
    const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
    const stopCapture = vi.fn(async () => speechTranscript({ text: "", seconds: 0, level: 0 }));
    const waiting = createVoiceController(
      {
        ...host.ctx,
        services: {
          ...host.ctx.services,
          speech: {
            ...host.ctx.services.speech,
            startCapture: vi.fn(async () => speechCapture({
              stop: stopCapture,
              cancel: vi.fn(async () => {}),
            })),
          },
        },
      },
      () => 42,
      () => ready,
    );
    host.commandResults.set("workspace.list", { ok: true, value: [] });
    await waiting.start("command");
    const stopping = waiting.stop();
    await Promise.resolve();
    expect(stopCapture).not.toHaveBeenCalled();
    release(await installedModels());
    await stopping;
    expect(stopCapture).toHaveBeenCalledOnce();
    expect(waiting.snapshot().phase).toBe("idle");
  });

  it("falls back to a CURRENT model, never a retired one, when the pick is gone", async () => {
    const host = hostWithSettings({ model: "removed-model" });
    const stopCapture = vi.fn(async () => speechTranscript({ text: "", seconds: 0, level: 0 }));
    // Two installed models, one of them retired. A pick that resolves to
    // nothing must land on the current one — the retired model is only ever a
    // last resort, and nothing else in the suite pins that preference.
    const models = (await installedModels()).map((model) => ({
      ...model,
      installed: model.id === "whisper-small" || model.id === "whisper-base-q5_1",
    }));
    const controller = createVoiceController(
      {
        ...host.ctx,
        services: {
          ...host.ctx.services,
          speech: {
            ...host.ctx.services.speech,
            startCapture: vi.fn(async () => speechCapture({
              stop: stopCapture,
              cancel: vi.fn(async () => {}),
            })),
          },
        },
      },
      () => 42,
      async () => models,
    );
    host.commandResults.set("workspace.list", { ok: true, value: [] });
    await controller.start("command");
    await controller.stop();
    expect(stopCapture).toHaveBeenCalledWith(
      expect.objectContaining({ modelPath: "models/ggml-small.bin" }),
    );
  });

  it("honors an installed pick even once the catalog retires it", async () => {
    // The discriminating half of the pair above: a retired model is never what
    // the fallback chain reaches for, so selecting one proves the persisted
    // pick was actually read — the fallback alone could not produce it.
    const host = hostWithSettings({ model: "whisper-base-q5_1" });
    const stopCapture = vi.fn(async () => speechTranscript({ text: "", seconds: 0, level: 0 }));
    const models = (await installedModels()).map((model) => ({
      ...model,
      installed: model.id === "whisper-small" || model.id === "whisper-base-q5_1",
    }));
    const controller = createVoiceController(
      {
        ...host.ctx,
        services: {
          ...host.ctx.services,
          speech: {
            ...host.ctx.services.speech,
            startCapture: vi.fn(async () => speechCapture({
              stop: stopCapture,
              cancel: vi.fn(async () => {}),
            })),
          },
        },
      },
      () => 42,
      async () => models,
    );
    host.commandResults.set("workspace.list", { ok: true, value: [] });
    await controller.start("command");
    await controller.stop();
    expect(stopCapture).toHaveBeenCalledWith(
      expect.objectContaining({ modelPath: "models/ggml-base-q5_1.bin" }),
    );
  });

  it("refuses an unresolvable workspace instead of guessing", async () => {
    const { host, controller } = setup(speechTranscript({ text: "switch to backend" }));
    await controller.start("command");
    await controller.stop();

    expect(host.executedCommands.map((e) => e.id)).not.toContain(
      "workspace.switch",
    );
    expect(texts(controller)).toContainEqual([
      "error",
      'no workspace sounds like "backend"',
    ]);
  });

  it("reports a non-command transcript without acting", async () => {
    const { host, controller } = setup(speechTranscript({ text: "what a lovely evening" }));
    await controller.start("command");
    await controller.stop();

    // One list call (the vocabulary prompt) — no resolution, no execution.
    expect(host.executedCommands.map((e) => e.id)).toEqual(["workspace.list"]);
    // Newest first: the verdict on the transcript sits above the transcript.
    expect(texts(controller)[0][0]).toBe("info");
  });

  it("says 'didn't catch that' on silence and never executes", async () => {
    const { host, controller } = setup(speechTranscript({ text: "", seconds: 0, level: 0 }));
    await controller.start("dictation");
    await controller.stop();
    expect(host.executedCommands.map((e) => e.id)).toEqual([
      "pane.target",
      "workspace.list",
    ]);
    expect(texts(controller)).toEqual([
      ["info", "didn't catch that (0.0s)"],
    ]);
  });

  it("names the mic permission when the hold is a dead signal", async () => {
    const { controller } = setup(speechTranscript({ silenceReason: "dead-signal", seconds: 2.4, level: 0 }));
    await controller.start("command");
    await controller.stop();
    const [tone, text] = texts(controller)[0];
    expect(tone).toBe("error");
    expect(text).toContain("Privacy & Security");
  });

  it("notes a hold whose audio stopped partway, above what was heard", async () => {
    const { controller } = setup(
      speechTranscript({ text: "close the", cutShort: true, seconds: 1.1, device: "BY-PM700" }),
    );
    await controller.start("command");
    await controller.stop();
    expect(texts(controller).slice(-2)).toEqual([
      ["error", "The microphone stopped partway (BY-PM700) — Only the first 1.1s were heard."],
      ["heard", "close the"],
    ]);
  });

  it("an empty hold whose audio stopped says so, not 'didn't catch that'", async () => {
    const { controller } = setup(speechTranscript({ silenceReason: "no-speech", cutShort: true, seconds: 0.5 }));
    await controller.start("command");
    await controller.stop();
    expect(texts(controller)[0][1]).toContain("stopped partway");
  });

  it("opens the picked microphone, and says once that it is not connected — not on every press", async () => {
    const host = hostWithSettings({
      [MIC_KEY]: { id: "coreaudio:usb-pm700", name: "BY-PM700" },
    });
    const startCapture = vi.fn(async () =>
      speechCapture({
        device: "MacBook Pro Microphone",
        deviceMissing: true,
        stop: async () => speechTranscript({ text: "" }),
      }),
    );
    const controller = createVoiceController(
      { ...host.ctx, services: { ...host.ctx.services, speech: { ...host.ctx.services.speech, startCapture } } },
      () => 42,
      installedModels,
    );
    await new Promise((resolve) => setTimeout(resolve, 0)); // the pick loads at construction
    await controller.start("command");
    expect(startCapture).toHaveBeenLastCalledWith(expect.any(Function), { deviceId: "coreaudio:usb-pm700" });
    await controller.cancel();

    for (let i = 0; i < 3; i++) {
      await controller.start("command");
      await controller.cancel();
    }
    expect(host.notifications).toEqual([
      { title: "Microphone not connected", body: undefined, severity: "warning", tag: "mic-missing", dockTab: "voice" },
    ]);
    expect(controller.snapshot().history.filter((e) => e.text === "Microphone not connected").length).toBeGreaterThan(0);
  });

  it("warns once about a distorting input and once about a cut-off hold", async () => {
    const { host, controller } = setup(
      speechTranscript({ text: "close", clippedRatio: 0.02, cutShort: true, seconds: 1, device: "BY-PM700" }),
    );
    for (let i = 0; i < 2; i++) {
      await controller.start("command");
      await controller.stop();
    }
    expect(host.notifications.map((n) => n.tag)).toEqual(["cut-short", "clipping"]);
  });

  it("a clean hold clears a hold problem, so its return is announced again", async () => {
    const { host, controller, stopCapture } = setup(speechTranscript({ text: "close", clippedRatio: 0.02 }));
    stopCapture
      .mockResolvedValueOnce(speechTranscript({ text: "close", clippedRatio: 0.02 }))
      .mockResolvedValueOnce(speechTranscript({ text: "close" }));
    for (let i = 0; i < 3; i++) {
      await controller.start("command");
      await controller.stop();
    }
    expect(host.notifications.map((n) => n.tag)).toEqual(["clipping", "clipping"]);
  });

  it("a refused microphone permission is announced and logged", async () => {
    const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
    const controller = createVoiceController(
      {
        ...host.ctx,
        services: {
          ...host.ctx.services,
          speech: {
            ...host.ctx.services.speech,
            startCapture: vi.fn(async () => {
              throw Object.assign(new Error("microphone permission is not granted"), { code: "permission" });
            }),
          },
        },
      },
      () => 42,
      installedModels,
    );
    await controller.start("command");
    expect(host.notifications.map((n) => n.tag)).toEqual(["permission"]);
    expect(texts(controller)[0]).toEqual(["error", "microphone permission is not granted"]);
    expect(controller.snapshot().phase).toBe("idle");
  });

  it("spawns in the active workspace when none was spoken — a peer as the new team's first", async () => {
    const { host, controller } = setup(speechTranscript({ text: "запусти нового пира" }));
    await controller.start("command");
    await controller.stop();
    expect(host.executedCommands).toContainEqual({
      id: "agent.spawn",
      args: { workspace: "ws-1", role: "peer" },
    });
  });

  it("refuses a spawn that names no role, and says how to name one", async () => {
    const { host, controller } = setup(speechTranscript({ text: "create an agent in keep deck" }));
    await controller.start("command");
    await controller.stop();
    expect(host.executedCommands.some((command) => command.id === "agent.spawn")).toBe(false);
    const [tone, text] = texts(controller)[0];
    expect(tone).toBe("error");
    expect(text).toContain("create a lead in <workspace>");
  });

  it("resolves 'the latest agent' positionally", async () => {
    const { host, controller } = setup(speechTranscript({ text: "close the latest open agent" }));
    await controller.start("command");
    await controller.stop();
    expect(host.executedCommands).toContainEqual({
      id: "agent.close",
      args: { agent: "p1" },
    });
  });

  it("keeps the newest entries when the history overruns its cap", async () => {
    // The cap drops from the TAIL now that entries are prepended — the
    // direction is invisible until the log actually overruns, so overrun it.
    let tick = 0;
    const { controller } = setup(
      speechTranscript({ text: "", seconds: 0, level: 0 }),
      () => ++tick,
    );
    // Silence yields exactly one "didn't catch that" entry per cycle.
    for (let i = 0; i < 120; i++) {
      await controller.start("dictation");
      await controller.stop();
    }
    const history = controller.snapshot().history;
    expect(history).toHaveLength(100);
    // Head is the very last thing said; the 20 oldest are gone, not the newest.
    expect(history[0].at).toBe(tick);
    expect(history.map((e) => e.at)).toEqual(
      [...history].map((e) => e.at).sort((a, b) => b - a),
    );
  });

  it("clears the history on demand", async () => {
    const { controller } = setup(speechTranscript({ text: "close" }));
    await controller.start("command");
    await controller.stop();
    expect(controller.snapshot().history.length).toBeGreaterThan(0);
    controller.clearHistory();
    expect(controller.snapshot().history).toEqual([]);
  });

  it("surfaces a failed command as an error entry", async () => {
    const { host, controller } = setup(speechTranscript({ text: "close" }));
    host.commandResults.set("agent.close", {
      ok: false,
      error: { code: "failed", message: "no agent selected" },
    });
    await controller.start("command");
    await controller.stop();
    expect(texts(controller)).toContainEqual(["error", "no agent selected"]);
  });

  it("cancel drops the capture without a transcript", async () => {
    const { controller, cancelCapture } = setup(speechTranscript({ text: "x" }));
    await controller.start("command");
    await controller.cancel();
    expect(controller.snapshot().phase).toBe("idle");
    expect(cancelCapture).toHaveBeenCalledOnce();
    expect(controller.snapshot().history).toEqual([]);
  });

  it("cancels an in-flight transcription without a late focus request", async () => {
    const { host, controller, cancelCapture, stopCapture } = setup(speechTranscript({ text: "late transcript" }));
    let finishTranscript!: (value: SpeechTranscript) => void;
    stopCapture.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishTranscript = resolve;
        }),
    );
    await controller.start("dictation");
    const stopping = controller.stop();
    await vi.waitFor(() => expect(stopCapture).toHaveBeenCalledOnce());

    const cancelling = controller.cancel();
    expect(cancelCapture).toHaveBeenCalledOnce();
    finishTranscript(speechTranscript({ text: "late transcript", seconds: 1, level: 0.1 }));
    await Promise.all([stopping, cancelling]);

    expect(host.executedCommands.map((entry) => entry.id)).not.toContain(
      "pane.write",
    );
    expect(controller.snapshot()).toMatchObject({ phase: "idle", history: [] });
  });

  it("cancels the native capture when model selection fails", async () => {
    const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
    const cancel = vi.fn(async () => {});
    const controller = createVoiceController(
      {
        ...host.ctx,
        services: {
          ...host.ctx.services,
          speech: {
            ...host.ctx.services.speech,
            startCapture: vi.fn(async () => speechCapture({
              stop: vi.fn(),
              cancel,
            })),
          },
        },
      },
      () => 42,
      async () => [],
    );

    await controller.start("command");
    await controller.stop();

    expect(cancel).toHaveBeenCalledOnce();
    expect(controller.snapshot().phase).toBe("idle");
  });

  it("cancels a capture that finishes starting during deactivation", async () => {
    const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
    const cancel = vi.fn(async () => {});
    let release!: (capture: Awaited<ReturnType<PluginContext["services"]["speech"]["startCapture"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<PluginContext["services"]["speech"]["startCapture"]>>>((resolve) => {
      release = resolve;
    });
    const controller = createVoiceController({
      ...host.ctx,
      services: {
        ...host.ctx.services,
        speech: {
          ...host.ctx.services.speech,
          startCapture: vi.fn(() => pending),
        },
      },
    });

    const start = controller.start("command");
    const closing = controller.cancel();
    release(speechCapture({ stop: vi.fn(), cancel }));
    await Promise.all([start, closing]);

    expect(cancel).toHaveBeenCalledOnce();
    expect(controller.snapshot().phase).toBe("idle");
  });

  it("closes a capture superseded while opening — release then press again", async () => {
    type Capture = Awaited<ReturnType<PluginContext["services"]["speech"]["startCapture"]>>;
    const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
    const opens: { release: (c: Capture) => void; onLevel: (rms: number) => void }[] = [];
    const controller = createVoiceController({
      ...host.ctx,
      services: {
        ...host.ctx.services,
        speech: {
          ...host.ctx.services.speech,
          startCapture: vi.fn(
            (onLevel: (rms: number) => void) =>
              new Promise<Capture>((resolve) => opens.push({ release: resolve, onLevel })),
          ),
        },
      },
    });
    const first = speechCapture({ stop: vi.fn(), cancel: vi.fn(async () => {}) });
    const second = speechCapture({ stop: vi.fn(), cancel: vi.fn(async () => {}) });

    const firstStart = controller.start("command");
    await controller.stop(); // released before the mic finished opening
    const secondStart = controller.start("command");
    opens[0].release(first);
    opens[1].release(second);
    await Promise.all([firstStart, secondStart]);

    expect(first.cancel).toHaveBeenCalledOnce();
    expect(second.cancel).not.toHaveBeenCalled();
    expect(controller.snapshot().phase).toBe("listening");

    // A late level from the superseded capture must not paint the live one.
    opens[1].onLevel(0.2);
    opens[0].onLevel(0.9);
    expect(controller.snapshot().level).toBe(0.2);
  });

  it("cancels a pending start exactly once when cancel() and a new press race it", async () => {
    type Capture = Awaited<ReturnType<PluginContext["services"]["speech"]["startCapture"]>>;
    const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
    const releases: ((c: Capture) => void)[] = [];
    const controller = createVoiceController({
      ...host.ctx,
      services: {
        ...host.ctx.services,
        speech: {
          ...host.ctx.services.speech,
          startCapture: vi.fn(() => new Promise<Capture>((resolve) => releases.push(resolve))),
        },
      },
    });
    const first = speechCapture({ stop: vi.fn(), cancel: vi.fn(async () => {}) });

    const firstStart = controller.start("command");
    const closing = controller.cancel();
    const secondStart = controller.start("command");
    releases[0](first);
    releases[1](speechCapture({ stop: vi.fn(), cancel: vi.fn(async () => {}) }));
    await Promise.all([firstStart, closing, secondStart]);

    expect(first.cancel).toHaveBeenCalledOnce();
  });

  it("never cancels twice when cancel() lands while the start is still closing its capture", async () => {
    type Capture = Awaited<ReturnType<PluginContext["services"]["speech"]["startCapture"]>>;
    const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
    let release!: (c: Capture) => void;
    const controller = createVoiceController({
      ...host.ctx,
      services: {
        ...host.ctx.services,
        speech: {
          ...host.ctx.services.speech,
          startCapture: vi.fn(() => new Promise<Capture>((resolve) => (release = resolve))),
        },
      },
    });
    let finishCancel!: () => void;
    const first = speechCapture({
      stop: vi.fn(),
      cancel: vi.fn(() => new Promise<void>((resolve) => (finishCancel = resolve))),
    });

    const starting = controller.start("command");
    await controller.stop(); // released before the mic opened
    release(first);
    await vi.waitFor(() => expect(first.cancel).toHaveBeenCalledOnce());
    // The start's own cancel is still in flight — cancel() must not add one.
    const closing = controller.cancel();
    finishCancel();
    await Promise.all([starting, closing]);

    expect(first.cancel).toHaveBeenCalledOnce();
  });

  it("ignores mic levels once the capture is no longer listening", async () => {
    const { controller, level } = setup(speechTranscript({ text: "close" }));
    await controller.start("command");
    level()?.(0.3);
    await controller.stop();
    level()?.(0.9);
    expect(controller.snapshot().level).toBe(0);
  });

  it("keeps the whole meter reading and the last hold for the mic block", async () => {
    const { controller, level } = setup(speechTranscript({ text: "close", dcOffset: 0.3 }));
    await controller.start("command");
    const reading = { rms: 0.2, peak: 0.6, clipped: false, dcOffset: 0.3 };
    (level() as (rms: number, r: typeof reading) => void)(0.2, reading);
    expect(controller.snapshot().reading).toEqual(reading);
    expect(controller.snapshot().readingAt).toBe(42);
    expect(controller.snapshot().device).toBe("Test Microphone");
    await controller.stop();
    expect(controller.snapshot().lastHold?.dcOffset).toBe(0.3);
  });

  it("feeds mic levels into the snapshot while listening", async () => {
    const { controller, level } = setup(speechTranscript({ text: "close" }));
    await controller.start("command");
    level()?.(0.42);
    expect(controller.snapshot().level).toBe(0.42);
  });
});
