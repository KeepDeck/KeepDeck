import { describe, expect, it } from "vitest";
import type { Standing } from "../../domain/lifecycle";
import { createStandingAnnouncer } from "./standing";

const WORKS = { sessionsDown: false };

describe("createStandingAnnouncer", () => {
  it("tells each standing fact once, as it is first heard, and nothing while KeepDeck works", () => {
    const said: Standing[] = [];
    const announcer = createStandingAnnouncer((standing) => said.push(standing));
    announcer.heard(WORKS);
    expect(said).toEqual([]);
    announcer.heard({ sessionsDown: true });
    announcer.heard({ sessionsDown: true });
    expect(said).toEqual(["sessionsDown"]);
    announcer.stopped();
    announcer.stopped();
    expect(said).toEqual(["sessionsDown", "stopped"]);
  });
});
