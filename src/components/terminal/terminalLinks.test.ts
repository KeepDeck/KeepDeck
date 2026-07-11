import { describe, expect, it } from "vitest";
import { linkOpenNotice } from "./terminalLinks";

describe("linkOpenNotice", () => {
  it("says 'Opened externally' exactly when a handler declined AND system took it", () => {
    expect(linkOpenNotice({ via: "system", declined: true })).toEqual({
      notice: "Opened externally",
    });
  });

  it("stays silent when a handler opened the file in-app", () => {
    expect(linkOpenNotice({ via: "peek", declined: false })).toBeUndefined();
    // …even after siblings declined first: the click DID land in-app.
    expect(linkOpenNotice({ via: "peek", declined: true })).toBeUndefined();
  });

  it("stays silent for the plain system open with nothing registered", () => {
    expect(linkOpenNotice({ via: "system", declined: false })).toBeUndefined();
  });
});
