import { describe, expect, it } from "vitest";
import type { EditorWorld } from "../library/useLibraryEditor";
import type { McpScope } from "../../domain/mcp";
import { EMPTY_MCP_FORM, type McpForm } from "./mcpForm";
import { mcpFormVerdicts } from "./mcpFormVerdicts";
import { mcpRowAt, type McpEditorScope, type McpRow } from "./mcpRows";

const GLOBAL: McpScope = { kind: "global" };
const row = (name: string, scope: McpEditorScope = GLOBAL): McpRow => ({
  scope,
  name,
  verdict: { kind: "ok", body: { transport: "stdio", command: "x", args: [], env: {} } },
});

const world = (over: Partial<EditorWorld<McpScope, McpRow, McpForm>> = {}) =>
  mcpFormVerdicts({
    selection: { mode: "create", scope: GLOBAL },
    form: { ...EMPTY_MCP_FORM, name: "fresh", command: "npx" },
    rows: [row("github")],
    listTrusted: true,
    busy: false,
    dirty: true,
    nameTouched: true,
    ...over,
  });

describe("the server form's verdicts", () => {
  it("lets a complete local server save", () => {
    expect(world().canSave).toBe(true);
  });

  it("refuses the field the body cannot do without, per transport", () => {
    expect(world({ form: { ...EMPTY_MCP_FORM, name: "a" } }).bodyProblem).toBe("empty-command");
    expect(
      world({ form: { ...EMPTY_MCP_FORM, name: "a", transport: "http" } }).bodyProblem,
    ).toBe("empty-url");
    expect(world({ form: { ...EMPTY_MCP_FORM, name: "a", transport: "http" } }).canSave).toBe(false);
  });

  it("refuses a line that is not a pair, and names it", () => {
    const v = world({ form: { ...EMPTY_MCP_FORM, name: "a", command: "x", env: "A=1\noops" } });
    expect(v.badLine).toBe("oops");
    expect(v.canSave).toBe(false);
    // Headers follow the same rule with their own separator.
    const h = world({
      form: { ...EMPTY_MCP_FORM, name: "a", transport: "http", url: "https://x/", headers: "no colon" },
    });
    expect(h.badLine).toBe("no colon");
  });

  it("takes the library-generic verdicts as they are — a taken name, a bad name", () => {
    expect(world({ form: { ...EMPTY_MCP_FORM, name: "github", command: "x" } }).nameTaken).toBe(true);
    expect(world({ form: { ...EMPTY_MCP_FORM, name: "my.server", command: "x" } }).nameProblem).toBe(
      "invalid",
    );
  });

  it("finds a row by scope and name, the bundled tier apart from the libraries", () => {
    const rows = [row("github"), row("keepdeck", { kind: "bundled" })];
    expect(mcpRowAt(rows, GLOBAL, "github")?.name).toBe("github");
    expect(mcpRowAt(rows, { kind: "bundled" }, "keepdeck")?.name).toBe("keepdeck");
    expect(mcpRowAt(rows, GLOBAL, "keepdeck")).toBeUndefined();
    expect(mcpRowAt(rows, { kind: "workspace", wsId: "ws-1" }, "github")).toBeUndefined();
  });

  it("names why an open file could not be read — the editor is repairing it", () => {
    const broken: McpRow = {
      scope: GLOBAL,
      name: "broken",
      verdict: { kind: "malformed", reason: "not valid JSON" },
    };
    const open = { mode: "edit" as const, scope: GLOBAL, name: "broken" };
    expect(world({ selection: open, rows: [broken] }).repairReason).toBe("not valid JSON");
    // A readable row, a create, a bundled view: nothing to repair.
    expect(world({ selection: open, rows: [row("broken")] }).repairReason).toBeNull();
    expect(world().repairReason).toBeNull();
  });
});
