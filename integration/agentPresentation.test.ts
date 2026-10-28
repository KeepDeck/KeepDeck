import { describe, expect, it } from "vitest";
import { isAgentPresentation, type AgentPresentation } from "@keepdeck/plugin-api";
import { claudePresentation } from "../plugins/claude/src/presentation";
import { codexPresentation } from "../plugins/codex/src/presentation";
import { kimiPresentation } from "../plugins/kimi/src/presentation";
import { opencodePresentation } from "../plugins/opencode/src/presentation";
import { activityBadge } from "../src/presentation/activityBadge";
import { SPARE_SLOTS } from "../src/presentation/usagePalette";

/** The bundled agents' presentation, read against the host that shows it. */
const PRESENTATIONS: Record<string, AgentPresentation> = {
  claude: claudePresentation,
  codex: codexPresentation,
  kimi: kimiPresentation,
  opencode: opencodePresentation,
};

describe("the bundled agents' presentation", () => {
  it("is well formed, as the host checks it at registration", () => {
    for (const [agent, presentation] of Object.entries(PRESENTATIONS)) {
      expect(isAgentPresentation(presentation), agent).toBe(true);
    }
  });

  it("names no code the host already words — each label is the one shown", () => {
    for (const [agent, presentation] of Object.entries(PRESENTATIONS)) {
      for (const [code, label] of Object.entries(presentation.failureLabels ?? {})) {
        const badge = activityBadge({ state: "failed", at: 1, error: code }, presentation.failureLabels);
        expect(badge.label, `${agent} ${code}`).toBe(label);
      }
    }
  });

  it("words a code two agents share the same way, so the deck reads one vocabulary", () => {
    const words = new Map<string, string>();
    for (const presentation of Object.values(PRESENTATIONS)) {
      for (const [code, label] of Object.entries(presentation.failureLabels ?? {})) {
        expect(words.get(code) ?? label, code).toBe(label);
        words.set(code, label);
      }
    }
  });

  it("gives each agent its own chart colour, none of them a spare slot", () => {
    const colours = Object.values(PRESENTATIONS).map((presentation) => presentation.chartColor);
    expect(new Set(colours).size).toBe(colours.length);
    for (const colour of colours) expect(SPARE_SLOTS).not.toContain(colour);
  });
});
