/**
 * The mail's owner for the lifecycle machine's commands: a closed pane's
 * mail goes — every pane of a closed team or workspace is named — and at
 * boot, the mail of every pane no longer on the deck. Forgetting twice is
 * forgetting once.
 */
import type { Outcome } from "../../ipc/generated/lifecycle/Outcome";
import { ownerRefused, type CommandOwner } from "../lifecycleSnapshot";

export interface MailPort {
  forget(paneIds: ReadonlySet<string>): void;
  retain(liveIds: ReadonlySet<string>): void;
}

const DONE: Outcome = { kind: "applied", revision: null };

export function createMailOwner(mail: MailPort): CommandOwner {
  return {
    carry({ cmd }) {
      switch (cmd.kind) {
        case "forgetPaneMail":
          mail.forget(new Set([cmd.pane]));
          return Promise.resolve(DONE);
        case "retainPanes":
          mail.retain(new Set(cmd.panes));
          return Promise.resolve(DONE);
        default:
          return Promise.resolve(ownerRefused({ kind: "wrongOwner", command: cmd.kind }));
      }
    },
  };
}
