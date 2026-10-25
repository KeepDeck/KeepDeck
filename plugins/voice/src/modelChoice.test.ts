import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, type VoiceModelInfo } from "./modelCatalog";
import { activeModel, MODEL_KEY, readModelPick } from "./modelChoice";
import { present } from "@keepdeck/plugin-api/testing";

const model = (id: string, installed: boolean): VoiceModelInfo => ({
  ...present(MODEL_CATALOG.find((m) => m.id === id), "the matching item"),
  installed,
});

describe("readModelPick", () => {
  it("reads a stored id, null otherwise", () => {
    expect(readModelPick({ [MODEL_KEY]: "parakeet-tdt-0.6b-v3" })).toBe("parakeet-tdt-0.6b-v3");
    expect(readModelPick({})).toBeNull();
    expect(readModelPick({ [MODEL_KEY]: 3 })).toBeNull();
  });
});

describe("activeModel", () => {
  it("is the pick when installed", () => {
    const models = [model("whisper-small", true), model("parakeet-tdt-0.6b-v3", true)];
    expect(activeModel(models, "parakeet-tdt-0.6b-v3")?.id).toBe("parakeet-tdt-0.6b-v3");
  });

  it("with no pick, is what is installed — not a fixed default that may be absent", () => {
    const models = [model("whisper-small", false), model("parakeet-tdt-0.6b-v3", true)];
    expect(activeModel(models, null)?.id).toBe("parakeet-tdt-0.6b-v3");
  });

  it("falls back to a current model before a retired one", () => {
    const models = [model("whisper-base-q5_1", true), model("parakeet-tdt-0.6b-v3", true)];
    expect(activeModel(models, "whisper-large-v3-turbo-q5_0")?.id).toBe("parakeet-tdt-0.6b-v3");
  });

  it("keeps a retired install working when it is all there is", () => {
    expect(activeModel([model("whisper-base-q5_1", true)], null)?.id).toBe("whisper-base-q5_1");
  });

  it("is null with nothing installed", () => {
    expect(activeModel([model("whisper-small", false)], "whisper-small")).toBeNull();
  });
});
