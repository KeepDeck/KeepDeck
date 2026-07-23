import { describe, expect, it, vi } from "vitest";
import type { PluginContext, SpeechTranscript } from "@keepdeck/plugin-api";
import {
  createFakeHost,
  fakeManifest,
} from "../../../packages/plugin-guest/src/fakeHost";
import { createVoiceController } from "./controller";
import { MODEL_CATALOG, type VoiceModelInfo } from "./modelCatalog";

const installedModels = async (): Promise<VoiceModelInfo[]> =>
  MODEL_CATALOG.map((model) => ({ ...model, installed: true }));

/** A fake host whose speech service yields scripted transcripts and whose
 * command results are primeable — the controller under real wiring. */
function setup(partial: Partial<SpeechTranscript> & Pick<SpeechTranscript, "text" | "silence">) {
  const transcript: SpeechTranscript = { seconds: 1.2, level: 0.05, ...partial };
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
          return { stop: stopCapture, cancel: cancelCapture };
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
      { id: "ws-2", name: "Website", active: false, panes: [] },
    ],
  });
  const controller = createVoiceController(ctx, () => 42, installedModels);
  return { host, controller, cancelCapture, level: () => onLevel };
}

const texts = (c: ReturnType<typeof createVoiceController>) =>
  c.snapshot().history.map((e) => [e.tone, e.text]);

describe("createVoiceController", () => {
  it("runs a spoken command end to end: heard → resolved → executed", async () => {
    const { host, controller } = setup({
      text: "Create an agent in keep deck with task fix the header.",
      silence: false,
    });
    await controller.start("command");
    expect(controller.snapshot().phase).toBe("listening");
    await controller.stop();

    expect(host.executedCommands).toEqual([
      { id: "workspace.list", args: {} },
      { id: "workspace.list", args: {} },
      {
        id: "agent.spawn",
        args: { workspace: "ws-1", task: "fix the header" },
      },
    ]);
    expect(texts(controller)).toEqual([
      ["heard", "Create an agent in keep deck with task fix the header."],
      ["done", "agent spawned, task queued"],
    ]);
    expect(controller.snapshot().phase).toBe("idle");
  });

  it("reads the persisted model pick from the plugin's settings values", async () => {
    const stop = vi.fn(async () => ({
      text: "close",
      silence: false,
      seconds: 1,
      level: 0.1,
    }));
    const host = createFakeHost({
      manifest: fakeManifest("keepdeck.voice"),
      settingsValues: { model: "whisper-small-q5_1" },
    });
    const ctx: PluginContext = {
      ...host.ctx,
      services: {
        ...host.ctx.services,
        speech: {
          ...host.ctx.services.speech,
          startCapture: vi.fn(async () => ({
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
    const { host, controller } = setup({
      text: "please refactor the parser",
      silence: false,
    });
    await controller.start("dictation");
    await controller.stop();

    expect(host.executedCommands).toEqual([
      { id: "workspace.list", args: {} },
      {
        id: "pane.write",
        args: { text: "please refactor the parser", mode: "type" },
      },
    ]);
    expect(texts(controller)).toEqual([
      ["heard", "please refactor the parser"],
      ["done", "typed into the input"],
    ]);
  });

  it("waits for the initial model scan before selecting an engine", async () => {
    let release!: (models: VoiceModelInfo[]) => void;
    const ready = new Promise<VoiceModelInfo[]>((resolve) => {
      release = resolve;
    });
    const host = createFakeHost({ manifest: fakeManifest("keepdeck.voice") });
    const stopCapture = vi.fn(async () => ({
      text: "",
      silence: true,
      seconds: 0,
      level: 0,
    }));
    const waiting = createVoiceController(
      {
        ...host.ctx,
        services: {
          ...host.ctx.services,
          speech: {
            ...host.ctx.services.speech,
            startCapture: vi.fn(async () => ({
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

  it("falls back when the persisted model is stale or not installed", async () => {
    const host = createFakeHost({
      manifest: fakeManifest("keepdeck.voice"),
      settingsValues: { model: "removed-model" },
    });
    const stopCapture = vi.fn(async () => ({
      text: "",
      silence: true,
      seconds: 0,
      level: 0,
    }));
    const models = (await installedModels()).map((model) => ({
      ...model,
      installed: model.id === "whisper-small",
    }));
    const controller = createVoiceController(
      {
        ...host.ctx,
        services: {
          ...host.ctx.services,
          speech: {
            ...host.ctx.services.speech,
            startCapture: vi.fn(async () => ({
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

  it("refuses an unresolvable workspace instead of guessing", async () => {
    const { host, controller } = setup({
      text: "switch to backend",
      silence: false,
    });
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
    const { host, controller } = setup({
      text: "what a lovely evening",
      silence: false,
    });
    await controller.start("command");
    await controller.stop();

    // One list call (the vocabulary prompt) — no resolution, no execution.
    expect(host.executedCommands.map((e) => e.id)).toEqual(["workspace.list"]);
    expect(texts(controller)[1][0]).toBe("info");
  });

  it("says 'didn't catch that' on silence and never executes", async () => {
    const { host, controller } = setup({ text: "", silence: true, seconds: 0, level: 0 });
    await controller.start("dictation");
    await controller.stop();
    expect(host.executedCommands.map((e) => e.id)).toEqual(["workspace.list"]);
    expect(texts(controller)).toEqual([
      ["info", "didn't catch that (0.0s, level 0.000)"],
    ]);
  });

  it("names the mic permission when a real duration arrives at level zero", async () => {
    const { controller } = setup({
      text: "",
      silence: true,
      seconds: 2.4,
      level: 0.0001,
    });
    await controller.start("command");
    await controller.stop();
    const [tone, text] = texts(controller)[0];
    expect(tone).toBe("error");
    expect(text).toContain("Privacy & Security");
  });

  it("spawns in the active workspace when none was spoken", async () => {
    const { host, controller } = setup({
      text: "запусти нового агента",
      silence: false,
    });
    await controller.start("command");
    await controller.stop();
    expect(host.executedCommands).toContainEqual({
      id: "agent.spawn",
      args: { workspace: "ws-1" },
    });
  });

  it("resolves 'the latest agent' positionally", async () => {
    const { host, controller } = setup({
      text: "close the latest open agent",
      silence: false,
    });
    await controller.start("command");
    await controller.stop();
    expect(host.executedCommands).toContainEqual({
      id: "agent.close",
      args: { agent: "p1" },
    });
  });

  it("clears the history on demand", async () => {
    const { controller } = setup({ text: "close", silence: false });
    await controller.start("command");
    await controller.stop();
    expect(controller.snapshot().history.length).toBeGreaterThan(0);
    controller.clearHistory();
    expect(controller.snapshot().history).toEqual([]);
  });

  it("surfaces a failed command as an error entry", async () => {
    const { host, controller } = setup({ text: "close", silence: false });
    host.commandResults.set("agent.close", {
      ok: false,
      error: { code: "failed", message: "no agent selected" },
    });
    await controller.start("command");
    await controller.stop();
    expect(texts(controller)).toContainEqual(["error", "no agent selected"]);
  });

  it("cancel drops the capture without a transcript", async () => {
    const { controller, cancelCapture } = setup({ text: "x", silence: false });
    await controller.start("command");
    await controller.cancel();
    expect(controller.snapshot().phase).toBe("idle");
    expect(cancelCapture).toHaveBeenCalledOnce();
    expect(controller.snapshot().history).toEqual([]);
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
            startCapture: vi.fn(async () => ({
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
    release({ stop: vi.fn(), cancel });
    await Promise.all([start, closing]);

    expect(cancel).toHaveBeenCalledOnce();
    expect(controller.snapshot().phase).toBe("idle");
  });

  it("feeds mic levels into the snapshot while listening", async () => {
    const { controller, level } = setup({ text: "close", silence: false });
    await controller.start("command");
    level()?.(0.42);
    expect(controller.snapshot().level).toBe(0.42);
  });
});
