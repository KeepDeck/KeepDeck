import { describe, expect, it } from "vitest";
import { normalize, parseCommand } from "./grammar";

describe("normalize", () => {
  it("strips STT dressing — case, punctuation, extra spaces", () => {
    expect(normalize("  Create an agent in KeepDeck.  ")).toBe(
      "create an agent in keepdeck",
    );
    expect(normalize("Закрой агента!")).toBe("закрой агента");
    expect(normalize("«Switch to Website»…")).toBe("switch to website");
  });
});

describe("parseCommand — english", () => {
  it("spawn with and without a task", () => {
    expect(parseCommand("Create an agent in KeepDeck.")).toEqual({
      locale: "en",
      intent: { kind: "spawn", workspace: "keepdeck" },
    });
    expect(
      parseCommand("spawn agent in website with task fix the header"),
    ).toEqual({
      locale: "en",
      intent: { kind: "spawn", workspace: "website", task: "fix the header" },
    });
    expect(
      parseCommand("start a new agent in KeepDeck and tell it to run the tests"),
    ).toEqual({
      locale: "en",
      intent: { kind: "spawn", workspace: "keepdeck", task: "run the tests" },
    });
    // No workspace spoken = the active one decides later.
    expect(parseCommand("create a new agent")).toEqual({
      locale: "en",
      intent: { kind: "spawn" },
    });
    expect(parseCommand("spawn agent with task fix the header")).toEqual({
      locale: "en",
      intent: { kind: "spawn", task: "fix the header" },
    });
  });

  it("switch", () => {
    expect(parseCommand("Switch to Website")).toEqual({
      locale: "en",
      intent: { kind: "switch", workspace: "website" },
    });
    expect(parseCommand("go to workspace keepdeck")).toEqual({
      locale: "en",
      intent: { kind: "switch", workspace: "keepdeck" },
    });
    expect(parseCommand("open workspace mnemo")).toEqual({
      locale: "en",
      intent: { kind: "switch", workspace: "mnemo" },
    });
  });

  it("focus and close", () => {
    expect(parseCommand("focus on agent claude 2")).toEqual({
      locale: "en",
      intent: { kind: "focus", agent: "claude 2" },
    });
    expect(parseCommand("close agent reviewer")).toEqual({
      locale: "en",
      intent: { kind: "close", agent: "reviewer" },
    });
    // Bare close targets the selected pane — no agent captured.
    expect(parseCommand("Close.")).toEqual({
      locale: "en",
      intent: { kind: "close" },
    });
  });
});

describe("parseCommand — russian", () => {
  it("spawn with and without a task", () => {
    expect(parseCommand("Создай агента в KeepDeck")).toEqual({
      locale: "ru",
      intent: { kind: "spawn", workspace: "keepdeck" },
    });
    expect(
      parseCommand("создай агента в вебсайте с задачей поправить хедер"),
    ).toEqual({
      locale: "ru",
      intent: { kind: "spawn", workspace: "вебсайте", task: "поправить хедер" },
    });
    expect(
      parseCommand("запусти агента в keepdeck и скажи ему прогнать тесты"),
    ).toEqual({
      locale: "ru",
      intent: { kind: "spawn", workspace: "keepdeck", task: "прогнать тесты" },
    });
    expect(parseCommand("Запусти нового агента.")).toEqual({
      locale: "ru",
      intent: { kind: "spawn" },
    });
  });

  it("switch, focus, close", () => {
    expect(parseCommand("Переключись на Website")).toEqual({
      locale: "ru",
      intent: { kind: "switch", workspace: "website" },
    });
    expect(parseCommand("перейди в воркспейс mnemo")).toEqual({
      locale: "ru",
      intent: { kind: "switch", workspace: "mnemo" },
    });
    expect(parseCommand("выбери агента claude 2")).toEqual({
      locale: "ru",
      intent: { kind: "focus", agent: "claude 2" },
    });
    expect(parseCommand("Закрой агента ревьюер")).toEqual({
      locale: "ru",
      intent: { kind: "close", agent: "ревьюер" },
    });
    expect(parseCommand("закрой")).toEqual({
      locale: "ru",
      intent: { kind: "close" },
    });
  });
});

describe("parseCommand — non-commands", () => {
  it("returns null instead of guessing", () => {
    expect(parseCommand("what a nice day")).toBeNull();
    expect(parseCommand("пожалуйста сделай что-нибудь")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("...")).toBeNull();
  });
});
