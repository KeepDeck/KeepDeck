import { beforeEach, describe, expect, it, vi } from "vitest";
import { speechErrorKind } from "@keepdeck/plugin-api";

/**
 * The error contract with `src-tauri/src/voice.rs`: a voice command rejects
 * with `{ kind, message }`, and a plugin reads the kind off the `Error` it
 * receives. Mock the tauri boundary, run the real module, and check the kind
 * survives the trip end to end.
 */
const tauri = vi.hoisted(() => ({
  invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>): Promise<unknown> => undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: class {
    onmessage: (value: unknown) => void = () => {};
  },
}));

const { speechError, voiceCaptureStart } = await import("./voice");

beforeEach(() => tauri.invoke.mockReset());

describe("speechError", () => {
  it("turns the native { kind, message } into an Error whose code is the kind", () => {
    const error = speechError({ kind: "permission", message: "microphone permission is not granted" });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("microphone permission is not granted");
    expect(speechErrorKind(error)).toBe("permission");
  });

  it("keeps a bare string or junk as a plain Error with no kind", () => {
    expect(speechError("boom").message).toBe("boom");
    expect(speechErrorKind(speechError("boom"))).toBeNull();
    expect(speechErrorKind(speechError({ nope: 1 }))).toBeNull();
  });
});

describe("voice commands", () => {
  it("a refused start rejects with the native kind", async () => {
    tauri.invoke.mockRejectedValueOnce({ kind: "busy", message: "a capture is already running" });
    const rejected = await voiceCaptureStart("keepdeck.voice", () => {}).catch((e: unknown) => e);
    expect(speechErrorKind(rejected)).toBe("busy");
    expect((rejected as Error).message).toBe("a capture is already running");
  });

  it("a failed stop rejects with the native kind", async () => {
    tauri.invoke.mockResolvedValueOnce(undefined);
    const capture = await voiceCaptureStart("keepdeck.voice", () => {});
    tauri.invoke.mockRejectedValueOnce({ kind: "model-missing", message: "speech model is not downloaded" });
    const rejected = await capture
      .stop({ engine: "parakeet", modelPath: "models/x" })
      .catch((e: unknown) => e);
    expect(speechErrorKind(rejected)).toBe("model-missing");
  });
});
