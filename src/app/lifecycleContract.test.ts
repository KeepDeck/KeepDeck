import { describe, expect, expectTypeOf, it } from "vitest";
import {
  isForgotten,
  type Consent,
  type DeckFacts,
  type DeckLoad,
  type Forgotten,
  type Minted,
  type NoAnswer,
  type Refusal,
  type Site,
} from "../domain/lifecycle";
import type { Consent as WireConsent } from "../ipc/generated/lifecycle/Consent";
import type { DeckFacts as WireDeckFacts } from "../ipc/generated/lifecycle/DeckFacts";
import type { Minted as WireMinted } from "../ipc/generated/lifecycle/Minted";
import type { Site as WireSite } from "../ipc/generated/lifecycle/Site";
import { forgotten, refusals, replies, verdicts } from "../ipc/generated/lifecycle/examples";
import type { Forgotten as WireForgotten } from "../ipc/generated/lifecycle/Forgotten";
import type { Load } from "../ipc/generated/lifecycle/Load";
import type { Refusal as WireRefusal } from "../ipc/generated/lifecycle/Refusal";
import type { Reply } from "../ipc/generated/lifecycle/Reply";
import { noAnswerText, refusalText } from "../presentation/lifecycleWords";

/**
 * The page against what Rust really sends: the examples are written by the
 * lifecycle crate's own test, one of every kind, as a module TS compiles
 * against the wire types — and a new kind fails to compile in Rust until it
 * has its example.
 */
describe("the lifecycle's wire, as the page takes it", () => {
  it("names the same refusals, silences and forgotten set in the domain as on the wire", () => {
    expectTypeOf<Refusal>().toEqualTypeOf<WireRefusal>();
    expectTypeOf<NoAnswer>().toEqualTypeOf<Exclude<Reply, { kind: "answered" }>>();
    expectTypeOf<Forgotten>().toEqualTypeOf<WireForgotten>();
    expectTypeOf<DeckLoad>().toEqualTypeOf<Load>();
    expectTypeOf<DeckFacts>().toEqualTypeOf<WireDeckFacts>();
    expectTypeOf<Minted>().toEqualTypeOf<WireMinted>();
    expectTypeOf<Consent>().toEqualTypeOf<WireConsent>();
    expectTypeOf<Site>().toEqualTypeOf<WireSite>();
  });

  it("calls a source forgotten exactly when Rust does", () => {
    for (const { source, forgotten: verdict } of verdicts) {
      expect(isForgotten(forgotten, { workspace: source.workspaceId, team: source.team, pane: source.pane }), JSON.stringify(source)).toBe(verdict);
    }
  });

  it("has words for every refusal and every silence Rust sends", () => {
    const refused = replies.flatMap((reply) => (reply.kind === "answered" && reply.answer.kind === "refused" ? [reply.answer.refusal] : []));
    const silent = replies.flatMap((reply) => (reply.kind === "answered" ? [] : [reply]));
    expect(refused.map((refusal) => refusal.kind).sort()).toEqual(refusals.map((refusal) => refusal.kind).sort());
    const said = [...refused.map(refusalText), ...silent.map(noAnswerText)];
    expect(said.every((text) => text.trim().length > 0)).toBe(true);
    expect(new Set(said).size).toBe(said.length);
  });
});
