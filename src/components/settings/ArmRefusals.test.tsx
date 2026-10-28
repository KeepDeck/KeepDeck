// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { armRefusals } from "../../app/testing";
import { ARM_REFUSALS_TITLE } from "../../presentation/armRefusalsView";
import { ArmRefusals } from "./ArmRefusals";
import { present } from "@keepdeck/plugin-api/testing";

vi.mock("../../app/useAgents", () => ({
  useAgents: () => ({
    agents: [{ id: "kimi", label: "Kimi", command: "kimi", features: [], installed: true, path: null }],
    loading: false,
  }),
}));

describe("ArmRefusals", () => {
  let root: Root;
  beforeEach(() => {
    document.body.innerHTML = "<div id='host'></div>";
    root = createRoot(present(document.getElementById("host"), "host"));
  });
  afterEach(() => {
    act(() => root.unmount());
    act(() => armRefusals.forget(["/repo"]));
  });

  it("says nothing while nothing stands refused", () => {
    act(() => root.render(createElement(ArmRefusals)));
    expect(document.body.textContent).toBe("");
  });

  it("names the agent, the folder and the reason — and follows the store", () => {
    act(() => root.render(createElement(ArmRefusals)));
    act(() => armRefusals.record("kimi", "/repo", [{ path: ".kimi-code/mcp.json", reason: "it is yours" }]));
    expect(document.body.textContent).toContain(ARM_REFUSALS_TITLE);
    expect(document.body.textContent).toContain("Kimi: /repo/.kimi-code/mcp.json — it is yours");
    act(() => armRefusals.record("kimi", "/repo", []));
    expect(document.body.textContent).toBe("");
  });
});
