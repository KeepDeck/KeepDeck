/**
 * The command grammar — deterministic locale packs over one matcher, no LLM
 * in the loop. Each pack is DATA (patterns with named groups); adding a
 * language is a new pack plus golden tests, never a code change. The parser
 * returns raw spoken fragments (workspace/agent references, the task tail);
 * fuzzy resolution against real names is the caller's job — the grammar
 * never guesses.
 */
export type Intent =
  | { kind: "spawn"; workspace: string; task?: string }
  | { kind: "switch"; workspace: string }
  | { kind: "focus"; agent: string }
  | { kind: "close"; agent?: string };

interface Rule {
  pattern: RegExp;
  map(groups: Record<string, string | undefined>): Intent;
}

export interface LocalePack {
  locale: string;
  rules: Rule[];
}

/** STT decorates utterances with capitalization and trailing punctuation;
 * the grammar matches the words, not the dressing. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:"'«»„“”…]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const spawn = (g: Record<string, string | undefined>): Intent => ({
  kind: "spawn",
  workspace: g.ws ?? "",
  ...(g.task ? { task: g.task } : {}),
});

export const EN: LocalePack = {
  locale: "en",
  rules: [
    {
      pattern:
        /^(?:create|spawn|start|launch|add)(?: an?| a new| new)? agent (?:in|at|on) (?<ws>.+?)(?: (?:with(?: the)? task|and (?:tell|ask) (?:it|him|her|them) to) (?<task>.+))?$/,
      map: spawn,
    },
    {
      pattern: /^(?:switch|go|jump) to (?:workspace )?(?<ws>.+)$/,
      map: (g) => ({ kind: "switch", workspace: g.ws ?? "" }),
    },
    {
      pattern: /^open workspace (?<ws>.+)$/,
      map: (g) => ({ kind: "switch", workspace: g.ws ?? "" }),
    },
    {
      pattern: /^(?:focus|select)(?: on)?(?: agent)? (?<agent>.+)$/,
      map: (g) => ({ kind: "focus", agent: g.agent ?? "" }),
    },
    {
      pattern: /^close(?: (?:the )?agent)?(?: (?<agent>.+))?$/,
      map: (g) => ({ kind: "close", ...(g.agent ? { agent: g.agent } : {}) }),
    },
  ],
};

export const RU: LocalePack = {
  locale: "ru",
  rules: [
    {
      pattern:
        /^(?:создай|создать|запусти|запустить|добавь|добавить|подними)(?: нового| новых)? агента (?:в|на) (?<ws>.+?)(?: (?:с задачей|и скажи (?:ему|ей)|и попроси (?:его|её)|и пусть) (?<task>.+))?$/u,
      map: spawn,
    },
    {
      pattern:
        /^(?:перейди|перейти|переключись|переключиться|открой|открыть) (?:в|на) (?:воркспейс )?(?<ws>.+)$/u,
      map: (g) => ({ kind: "switch", workspace: g.ws ?? "" }),
    },
    {
      pattern:
        /^(?:фокус|выбери|выдели|сфокусируйся)(?: на)?(?: агент[ае]?)? (?<agent>.+)$/u,
      map: (g) => ({ kind: "focus", agent: g.agent ?? "" }),
    },
    {
      pattern: /^(?:закрой|закрыть)(?: агента?)?(?: (?<agent>.+))?$/u,
      map: (g) => ({ kind: "close", ...(g.agent ? { agent: g.agent } : {}) }),
    },
  ],
};

export const DEFAULT_PACKS: LocalePack[] = [EN, RU];

export interface Parsed {
  intent: Intent;
  locale: string;
}

/** Parse one utterance against the packs, first match wins. Null = not a
 * command — the caller shows the transcript instead of acting on a guess. */
export function parseCommand(
  text: string,
  packs: LocalePack[] = DEFAULT_PACKS,
): Parsed | null {
  const utterance = normalize(text);
  if (!utterance) return null;
  for (const pack of packs) {
    for (const rule of pack.rules) {
      const match = utterance.match(rule.pattern);
      if (match) {
        return { intent: rule.map(match.groups ?? {}), locale: pack.locale };
      }
    }
  }
  return null;
}
