import { describe, expect, it } from "vitest";
import { usageEvent } from "../history/event.testSupport";
import { dimensionKey } from "./dimensions";

describe("breakdown keys", () => {
  it("keeps two providers of one model apart, and one model under two CLIs apart", () => {
    const zai = usageEvent({ agent: "opencode", model: "zai/glm-5.3", modelName: "GLM-5.3" });
    const own = usageEvent({ agent: "opencode", model: "opencode/glm-5.3", modelName: "GLM-5.3" });
    const other = usageEvent({ agent: "kimi", model: "zai/glm-5.3", modelName: "GLM-5.3" });
    const keys = new Set([zai, own, other].map((row) => dimensionKey("model", row)));
    expect(keys.size).toBe(3);
  });

  it("keys a session by agent and id — the same id under two CLIs is two sessions", () => {
    const a = usageEvent({ agent: "claude", sessionId: "s1" });
    const b = usageEvent({ agent: "codex", sessionId: "s1" });
    expect(dimensionKey("session", a)).not.toBe(dimensionKey("session", b));
  });

  it("keys a workspace by its name, whatever slot it sits in", () => {
    const a = usageEvent({ workspaceId: "ws-1", workspaceName: "KeepDeck" });
    const b = usageEvent({ workspaceId: "ws-2", workspaceName: "KeepDeck" });
    expect(dimensionKey("workspace", a)).toBe(dimensionKey("workspace", b));
  });
});
