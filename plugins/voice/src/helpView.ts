import { COMMAND_DOCS } from "./commandList";

/**
 * The help card's content — its words and the pieces of each command
 * template — decided here; the card lays them out.
 */

/** A spoken template as plain text and `<placeholder>` slots the user fills. */
export function templateParts(template: string): { text: string; slot: boolean }[] {
  return template
    .split(/(<[^>]+>)/)
    .filter((part) => part !== "")
    .map((part) => ({ text: part, slot: part.startsWith("<") }));
}

export interface HelpView {
  label: string;
  /** A key (or chord) and what holding / pressing it does. */
  command: { keys: string; text: string };
  commands: { template: string; parts: { text: string; slot: boolean }[] }[];
  dictation: { keys: string; text: string };
  escape: { keys: string; text: string };
  note: string;
}

export function helpView(commandChord: string, dictationChord: string): HelpView {
  return {
    label: "How to use voice",
    command: { keys: commandChord, text: " hold — speak a command, released = executed" },
    commands: COMMAND_DOCS.map((doc) => ({ template: doc.template, parts: templateParts(doc.template) })),
    dictation: { keys: dictationChord, text: " hold — dictate into the focused agent, released = typed in" },
    escape: { keys: "Esc", text: " while holding — cancel; while transcribing — discard" },
    note: "Commands are understood in English and Russian (examples are in English); dictation types whatever language the model hears.",
  };
}
