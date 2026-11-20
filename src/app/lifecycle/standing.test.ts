import { describe, expect, it } from "vitest";
import type { Standing } from "../../domain/lifecycle";
import { createStandingAnnouncer } from "./standing";

const WORKS = { viewOnly: false, sessionsDown: false };

describe("createStandingAnnouncer", () => {
  it("tells each standing fact once, as it is first heard, and nothing while KeepDeck works", () => {
    const said: Standing[] = [];
    const announcer = createStandingAnnouncer((standing) => said.push(standing));
    announcer.heard(WORKS);
    expect(said).toEqual([]);
    announcer.heard({ viewOnly: true, sessionsDown: false });
    announcer.heard({ viewOnly: true, sessionsDown: false });
    expect(said).toEqual(["viewOnly"]);
    announcer.heard({ viewOnly: true, sessionsDown: true });
    expect(said).toEqual(["viewOnly", "sessionsDown"]);
    announcer.stopped();
    announcer.stopped();
    expect(said).toEqual(["viewOnly", "sessionsDown", "stopped"]);
  });
});
