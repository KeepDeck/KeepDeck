/**
 * The command reference — what a user can say, as DATA so the dock tab's
 * idle state and the help card render the same list. Templates use
 * `<placeholder>` for the parts the user fills (a workspace or agent name),
 * so nothing shows a fake concrete name like "Website".
 */
export interface CommandDoc {
  /** The spoken template, `<...>` marking the user's own words. */
  template: string;
  /** What it does, one short line. */
  effect: string;
}

export const COMMAND_DOCS: CommandDoc[] = [
  { template: "create a lead in <workspace>", effect: "spawn an agent as its team's lead" },
  { template: "create a peer in <workspace>", effect: "spawn an agent as a peer" },
  {
    template: "create a lead in <workspace> with task <what to do>",
    effect: "spawn one and give it a task",
  },
  { template: "switch to <workspace>", effect: "change workspace" },
  { template: "focus <agent>", effect: "select an agent pane" },
  { template: "close <agent>", effect: "close a pane (asks to confirm)" },
  { template: "close the latest agent", effect: "close the newest pane" },
];
