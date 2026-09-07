/**
 * What happens to an agent that already exists: focus, close, suspend,
 * resume, and typing into it. One module because they share a subject — a
 * live pane — and each is a step in the same life.
 */
import {
  type CommandRegistry,
} from "../../domain/commands";
import {
  paneDisplayTitle,
} from "../../domain/deck";
import { paneInputReady, pasteToPane, writeRawToPane } from "../paneInput";
import { resumeRefusalText } from "../resumeOutcome";
import { suspendRefusalText } from "../suspendOutcome";
import { requiredStr, str, text } from "./args";

/**
 * The deck's core command set — what any invoker (voice, MCP, hotkeys, a
 * future palette) can do to the deck through the command registry. The plain
 * application controller registers once; accessors read the current store and
 * current UI port for every invocation. This is the STATIC registration
 * lifecycle; feature-gated command sets have their own register/dispose
 * lifecycle. The split is deliberate: a feature toggle must not re-register
 * or tear down the core set.
 */
import type { CoreCommandDeps } from "./deps";
import {
  targetPane,
  targetWorkspace,
} from "./targets";

export function registerLifecycleCommands(
  registry: CommandRegistry,
  deps: CoreCommandDeps,
): (() => void)[] {

  return [
    registry.register({
      id: "agent.focus",
      title: "Select an agent pane",
      args: [
        {
          name: "agent",
          type: "string",
          required: true,
          description: "Agent pane title, name, or id",
        },
        {
          name: "workspace",
          type: "string",
          description: "Workspace name or id; the active one when omitted",
        },
      ],
      run: (args) => {
        const deck = deps.deck();
        const ws = targetWorkspace(deck, str(args, "workspace"));
        // `agent` is required here (unlike every other command in this set,
        // where the selected pane is the default), so a blank one must be
        // refused rather than resolve to the pane already focused.
        const pane = targetPane(deck, deps.agents(), ws, requiredStr(args, "agent"));
        deps.activatePane(ws.id, pane.id);
        return { workspaceId: ws.id, paneId: pane.id };
      },
    }),

    registry.register({
      id: "agent.close",
      title: "Close an agent pane (opens the confirm dialog)",
      args: [
        {
          name: "agent",
          type: "string",
          description: "Agent pane title, name, or id; the selected one when omitted",
        },
        {
          name: "workspace",
          type: "string",
          description: "Workspace name or id; the active one when omitted",
        },
      ],
      run: (args) => {
        const deck = deps.deck();
        const agents = deps.agents();
        const ws = targetWorkspace(deck, str(args, "workspace"));
        const pane = targetPane(deck, agents, ws, str(args, "agent"));
        const label = paneDisplayTitle(pane, ws.panes.indexOf(pane), agents);
        deps.requestCloseAgent(ws.id, pane.id, label);
        return { workspaceId: ws.id, paneId: pane.id, confirm: "dialog" };
      },
    }),

    registry.register({
      id: "agent.suspend",
      title: "Suspend an agent pane (stops it, keeps the pane)",
      args: [
        {
          name: "agent",
          type: "string",
          description: "Agent pane title, name, or id; the selected one when omitted",
        },
        {
          name: "workspace",
          type: "string",
          description: "Workspace name or id; the active one when omitted",
        },
      ],
      // Not destructive, and so not behind the confirm dialog `agent.close`
      // uses: the pane, its worktree and its session all survive, and the
      // agent comes back with a resume.
      run: async (args) => {
        const deck = deps.deck();
        const agents = deps.agents();
        const ws = targetWorkspace(deck, str(args, "workspace"));
        const pane = targetPane(deck, agents, ws, str(args, "agent"));
        const label = paneDisplayTitle(pane, ws.panes.indexOf(pane), agents);
        // A caller that hears "ok" must be able to believe it, and one that
        // hears "no" deserves the real reason — the same sentence the hotkey
        // shows, not a second guess at it.
        const outcome = await deps.suspendAgent(ws.id, pane.id);
        if (outcome !== "suspended") {
          throw new Error(suspendRefusalText(outcome, label));
        }
        return { workspaceId: ws.id, paneId: pane.id };
      },
    }),

    registry.register({
      id: "agent.resume",
      title: "Resume a stopped agent pane",
      args: [
        {
          name: "agent",
          type: "string",
          description: "Agent pane title, name, or id; the selected one when omitted",
        },
        {
          name: "workspace",
          type: "string",
          description: "Workspace name or id; the active one when omitted",
        },
      ],
      // The inverse of `agent.suspend`. Without it an automation that parks an
      // agent has stranded it: nothing it can address brings the pane back.
      run: (args) => {
        const deck = deps.deck();
        const agents = deps.agents();
        const ws = targetWorkspace(deck, str(args, "workspace"));
        const pane = targetPane(deck, agents, ws, str(args, "agent"));
        const label = paneDisplayTitle(pane, ws.panes.indexOf(pane), agents);
        // The flow decides and reports; guessing the answer here is what let
        // the sibling command claim success for a resume that did nothing.
        // A switch rather than a chain of ifs, so a new outcome is a compile
        // error here instead of silently reporting success for it.
        const outcome = deps.resumeAgent(ws.id, pane.id);
        if (outcome === "resuming") return { workspaceId: ws.id, paneId: pane.id };
        throw new Error(resumeRefusalText(outcome, label));
      },
    }),

    registry.register({
      id: "pane.write",
      title: "Send text into an agent pane",
      args: [
        { name: "text", type: "string", required: true, description: "Text to send" },
        {
          name: "agent",
          type: "string",
          description: "Agent pane title, name, or id; the selected one when omitted",
        },
        {
          name: "workspace",
          type: "string",
          description: "Workspace name or id; the active one when omitted",
        },
        {
          name: "submit",
          type: "boolean",
          description: "Also press Enter after the text",
        },
        {
          name: "mode",
          type: "string",
          description:
            "'type' inserts raw keystrokes that stay inline and editable (no [Pasted…] collapse); 'paste' uses bracketed paste (default)",
        },
        {
          name: "focusInput",
          type: "boolean",
          description: "Select the target pane and return keyboard focus to it",
        },
      ],
      run: (args) => {
        // Validate the mode up front: a misspelled value must NOT silently
        // fall through to paste — that is the exact [Pasted…] collapse this
        // command's type mode exists to avoid (args-validation philosophy,
        // domain/commands/args.ts: reject rather than silently do nothing).
        const mode = str(args, "mode");
        if (mode !== undefined && mode !== "type" && mode !== "paste") {
          throw new Error(
            `unknown pane.write mode ${JSON.stringify(String(mode))} — expected "type" or "paste"`,
          );
        }
        const deck = deps.deck();
        const ws = targetWorkspace(deck, str(args, "workspace"));
        const pane = targetPane(deck, deps.agents(), ws, str(args, "agent"));
        // Through the shared reader, VERBATIM: a lone space is legitimate text
        // to send a terminal, so this is the one argument kind that must not be
        // trimmed or refused for being blank.
        const payload = text(args, "text");
        if (!paneInputReady(pane.id)) {
          throw new Error("the pane has no live session");
        }
        if (mode === "type") {
          // Raw keystrokes land as if hand-typed, so the text stays inline and
          // editable — a bracketed paste is what the agent TUIs collapse into a
          // non-editable [Pasted …] placeholder. LF (0x0A, Ctrl+J) inserts a
          // soft newline in every supported agent; a raw CR (0x0D) submits
          // mid-text, so normalise EVERY line ending to LF first.
          const typed = payload.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
          if (!writeRawToPane(pane.id, typed)) {
            throw new Error("the pane has no input channel");
          }
        } else {
          // A live but TYPE-only pane (no paste channel) cannot accept a
          // pasted payload — name that distinctly from "no session".
          if (!pasteToPane(pane.id, payload)) {
            throw new Error("the pane has no paste channel");
          }
        }
        // Submit Enter is a separate RAW keystroke after the text — see
        // deliverTask for why a CR cannot ride inside the pasted payload, and
        // why a raw CR is the submit gesture in type mode too.
        if (args.submit === true) writeRawToPane(pane.id, "\r");
        if (args.focusInput === true) deps.activatePane(ws.id, pane.id);
        return { workspaceId: ws.id, paneId: pane.id };
      },
    }),
  ];
}
