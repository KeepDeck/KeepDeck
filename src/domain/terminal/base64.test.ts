import { describe, expect, it } from "vitest";
import { bytesFromBase64 } from "./base64";

const toBase64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));

describe("bytesFromBase64", () => {
  it("round-trips every byte value, the high half included", () => {
    const every = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(bytesFromBase64(toBase64(every))).toEqual(every);
  });

  it("decodes the padded tails", () => {
    expect(bytesFromBase64("YQ==")).toEqual(Uint8Array.of(0x61));
    expect(bytesFromBase64("YWI=")).toEqual(Uint8Array.of(0x61, 0x62));
  });

  it("decodes nothing to no bytes", () => {
    expect(bytesFromBase64("")).toEqual(new Uint8Array(0));
  });

  it("rejects a string that is not base64", () => {
    expect(() => bytesFromBase64("not base64!")).toThrow();
  });
});
