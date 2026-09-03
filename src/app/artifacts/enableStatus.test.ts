import { describe, expect, it } from "vitest";
import { createArtifactsEnableStatus, refusalOf } from "./enableStatus";

describe("createArtifactsEnableStatus", () => {
  it("keeps the last transition whole and tells its readers", () => {
    // Verbatim on purpose: a settings row and a registry want different
    // sentences out of the same fact, so the store must not pre-chew it.
    const status = createArtifactsEnableStatus();
    let told = 0;
    const stop = status.subscribe(() => {
      told += 1;
    });
    expect(status.last()).toBeNull();

    const transition = { desired: true, ok: false, detail: "owned elsewhere" };
    status.record(transition);
    expect(status.last()).toEqual(transition);
    expect(told).toBe(1);

    stop();
    status.record({ desired: true, ok: true, detail: null });
    expect(told).toBe(1);
  });
});

describe("refusalOf", () => {
  it("names the reason only when the app WANTED the store open and failed", () => {
    expect(
      refusalOf({
        desired: true,
        ok: false,
        detail: "artifact store is owned by another KeepDeck process",
      }),
    ).toBe("artifact store is owned by another KeepDeck process");
  });

  it("has nothing to say about a store that is off by choice", () => {
    // The user turned the experiment off and can see that; calling it a
    // refusal would make their own setting look like a fault.
    expect(refusalOf({ desired: false, ok: true, detail: null })).toBeNull();
    expect(refusalOf({ desired: true, ok: true, detail: "display server on port 1" })).toBeNull();
    expect(refusalOf(null)).toBeNull();
  });
});
