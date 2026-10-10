import { describe, expect, it } from "vitest";
import { MODEL_CATALOG, type VoiceModelInfo } from "./modelCatalog";
import { modelCards, modelName } from "./modelsView";

const model = (id: string, installed: boolean): VoiceModelInfo => ({
  ...MODEL_CATALOG.find((m) => m.id === id)!,
  installed,
});
const NO_DL = { active: {}, errors: {}, interrupted: {} };

describe("modelName", () => {
  it("is the catalog label without its tail — one name everywhere", () => {
    expect(modelName("parakeet-tdt-0.6b-v3")).toBe("Parakeet TDT 0.6B v3");
    expect(modelName("whisper-large-v3-turbo-q5_0")).toBe("Whisper Large v3 Turbo");
  });

  it("an unknown id names itself", () => {
    expect(modelName("mystery")).toBe("mystery");
  });
});

describe("modelCards", () => {
  it("hides a retired model with nothing installed, marks a retired install Legacy", () => {
    const cards = modelCards([model("whisper-base-q5_1", false), model("whisper-small-q5_1", true)], null, NO_DL, {});
    expect(cards.map((c) => [c.id, c.legacy])).toEqual([["whisper-small-q5_1", true]]);
  });

  it("offers Delete for an installed model and marks only the active one", () => {
    const cards = modelCards(
      [model("whisper-small", true), model("parakeet-tdt-0.6b-v3", true)],
      "parakeet-tdt-0.6b-v3",
      NO_DL,
      {},
    );
    expect(cards.map((c) => [c.id, c.active, c.action.kind])).toEqual([
      ["whisper-small", false, "delete"],
      ["parakeet-tdt-0.6b-v3", true, "delete"],
    ]);
  });

  it("an absent model offers Download, then Retry after a failure", () => {
    const absent = [model("parakeet-tdt-0.6b-v3", false)];
    expect(modelCards(absent, null, NO_DL, {})[0].action).toEqual({ kind: "download", label: "Download" });
    const failed = { active: {}, errors: { "parakeet-tdt-0.6b-v3": "network down" }, interrupted: {} };
    const card = modelCards(absent, null, failed, {})[0];
    expect(card.action).toEqual({ kind: "download", label: "Retry" });
    expect(card.error).toBe("network down");
  });

  it("a download in flight offers Cancel with its progress and a bar", () => {
    const dl = {
      active: { "parakeet-tdt-0.6b-v3": { phase: "downloading", received: 50, total: 100 } },
      errors: {},
    } as never;
    const card = modelCards([model("parakeet-tdt-0.6b-v3", false)], null, dl, {})[0];
    expect(card.action).toEqual({ kind: "cancel", progress: "50%" });
    expect(card.bar).toEqual({ percent: 50 });
  });

  it("a failed deletion shows on its card", () => {
    const card = modelCards([model("parakeet-tdt-0.6b-v3", true)], null, NO_DL, {
      "parakeet-tdt-0.6b-v3": "Could not delete: file is busy",
    })[0];
    expect(card.error).toBe("Could not delete: file is busy");
  });

  it("an installed model cannot be marked active unless it is the active id", () => {
    expect(modelCards([model("whisper-small", false)], "whisper-small", NO_DL, {})[0].active).toBe(false);
  });

  it("a stopped download can be discarded, a clean absent model cannot", () => {
    const absent = [model("parakeet-tdt-0.6b-v3", false)];
    expect(modelCards(absent, null, NO_DL, {})[0].discardable).toBe(false);
    const stopped = { ...NO_DL, interrupted: { "parakeet-tdt-0.6b-v3": true as const } };
    expect(modelCards(absent, null, stopped, {})[0].discardable).toBe(true);
  });

  it("sizes come from the integrity bytes, in decimal MB", () => {
    // 478,517,071 bytes — the catalog's hand-kept 456 was MiB.
    expect(modelCards([model("parakeet-tdt-0.6b-v3", false)], null, NO_DL, {})[0].size).toBe("479 MB");
  });
});
