import { describe, expect, it } from "vitest";
import { isMessageId } from "./cancel";

describe("isMessageId", () => {
  it("accepts what mail.send hands back", () => {
    // The shape is the minting rule. An id is meant to travel from the send's
    // answer to the cancel's argument unchanged.
    expect(isMessageId("mail-1")).toBe(true);
    expect(isMessageId("mail-4096")).toBe(true);
  });

  it("refuses a role, which is the likeliest thing to arrive by mistake", () => {
    // Every other mail argument is an address, so an agent reaching for
    // cancel will reach for one here too. Saying "that is not an id" tells it
    // what it did; saying "no such message" would send it looking for a
    // message that was never the problem.
    expect(isMessageId("impl-1")).toBe(false);
    expect(isMessageId("lead")).toBe(false);
  });

  it("refuses anything shaped like an id but not one", () => {
    for (const near of ["mail-", "mail-1a", "-1", "mail1", "MAIL-1", " mail-1"]) {
      expect(isMessageId(near), near).toBe(false);
    }
  });
});
