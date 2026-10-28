import { describe, expect, it } from "vitest";
import { claudeBinding } from "../plugins/claude/src/binding";
import { codexBinding } from "../plugins/codex/src/binding";
import { kimiBinding } from "../plugins/kimi/src/binding";
import { opencodeBinding } from "../plugins/opencode/src/binding";
import { bindingOrigin } from "../src/app/paneAttribution";

/**
 * Each bundled agent's words for a continued session, read by the host's
 * one rule. The host knows no word itself: a word one agent uses for a
 * continuation can be another's fresh start.
 */
describe("the bundled agents' session-origin words", () => {
  const origin = (binding: { swapSources: readonly string[] }, source: string) =>
    bindingOrigin(source, binding.swapSources);

  it("read claude's and codex's hook words as continuations", () => {
    for (const binding of [claudeBinding, codexBinding]) {
      for (const word of ["resume", "clear", "compact", "fork"]) expect(origin(binding, word), word).toBe("swap");
      expect(origin(binding, "new")).toBe("startup");
    }
  });

  it("read opencode's `new` as a continuation in place, and nobody else's", () => {
    expect(origin(opencodeBinding, "new")).toBe("swap");
    expect(origin(opencodeBinding, "resume")).toBe("swap");
    expect(origin(opencodeBinding, "clear")).toBe("startup");
  });

  it("read kimi's `/new` and `/clear` as fresh starts its restart callback answers", () => {
    expect(origin(kimiBinding, "resume")).toBe("swap");
    expect(origin(kimiBinding, "startup")).toBe("startup");
    expect(kimiBinding.restartsConversation({ source: "startup", facts: {} })).toBe(true);
  });

  it("read a word no agent declares as a fresh start", () => {
    for (const binding of [claudeBinding, codexBinding, kimiBinding, opencodeBinding]) {
      expect(origin(binding, "teleported")).toBe("startup");
    }
  });
});
