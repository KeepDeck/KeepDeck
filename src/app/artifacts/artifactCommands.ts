/**
 * The artifact_* commands — the agent-facing surface, registered on the
 * deck's command registry (which IS the MCP projection: registering here
 * makes the tools appear for every connected pane).
 *
 * The THREE-RUNG LADDER (§D1): (1) anonymous caller → refusal with the
 * remedy, all four tools; (2) resolved sender, no pane cwd (provisioning
 * or remote pane) → publish CONTINUES, `path` refused with remedy,
 * `content` allowed, `cwd: null` rides the payload; (3) cwd resolved →
 * full publish with the §6 enforcement Rust-side. No rung short-circuits
 * what a later rung preserves.
 *
 * Identity is HOST FACT: the CommandSource's resolved pane, never an
 * agent argument. The agent-facing WIRE result carries composed URLs and
 * never the raw token (B10); `isNew` survives into the IPC result for the
 * notification producers even though the wire drops it (D2's rule).
 */
import type {
  CommandRegistry,
  CommandSource,
  CommandSpec,
} from "../../domain/commands";
import type { Workspace } from "../../domain/deck";
import { findWorkspaceOfPane } from "../../domain/deck";
import { paneExecutionCwd } from "../../domain/deck/roots";
import {
  isArtifactFormat,
  MESSAGE_MAX,
  TITLE_MAX,
  validateMessage,
  validateTitle,
} from "../../domain/artifacts/model";
import { getSettings } from "../settingsManager";
import { DEFAULT_SETTINGS } from "../../domain/settings";
import {
  artifactDelete,
  artifactList,
  artifactPublish,
  artifactRead,
} from "../../ipc/artifacts";

/** What the Rust publish result gives the command layer (urls null while
 * the display server is down — a publish never fails on that). */
export interface ArtifactCommandDeps {
  /** The live deck — workspaces and panes for identity resolution. */
  deck: () => { workspaces: Workspace[] } | null;
  /** The notification producers' announce — first-publish and delete
   * events (republish never announces; the note carries it). */
  announce?: (event: {
    kind: "published" | "deleted";
    workspaceId: string;
    workspaceInstance: Workspace["instance"];
    slug: string;
    paneLabel: string;
  }) => void;
}

/** The refusal every artifact tool gives an anonymous caller — reason
 * AND remedy, per the design's §3 populations. */
function anonymousRefusal(): Error {
  return new Error(
    "artifact tools are deck-internal: publishing needs a KeepDeck-launched pane (no workspace to scope to); run the agent inside a KeepDeck pane or via the injected shim",
  );
}

function str(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" ? value : undefined;
}

/** The resolved rung-3 context: which workspace, which pane, which cwd. */
interface CallerContext {
  workspaceId: string;
  workspaceInstance: Workspace["instance"];
  paneId: string;
  label: string;
  cwd: string | null;
  /** A remote pane: the path arm is structurally unavailable (the cwd is
   * a remote path string Rust cannot canonicalize) — refused by NAME,
   * not by a confusing ENOENT from the canonicalizer. */
  remote: boolean;
}

/** Rungs 1-3 of the ladder. Returns the context, or throws the refusal.
 * The source's pane `{id, workspaceId, label}` is the RESOLVED identity
 * (spawn-secret → pane at call time); findWorkspaceOfPane turns the
 * reusable id into this deck's live pane+workspace for the cwd. */
function callerContext(
  source: CommandSource,
  deps: ArtifactCommandDeps,
): CallerContext {
  const pane =
    source.kind === "external" && source.pane ? source.pane : undefined;
  if (!pane) throw anonymousRefusal();
  const deck = deps.deck();
  const owner = findWorkspaceOfPane(deck?.workspaces ?? [], pane.id);
  const found = owner?.panes.find((p) => p.id === pane.id);
  if (owner && found) {
    return {
      workspaceId: owner.id,
      workspaceInstance: owner.instance,
      paneId: found.id,
      label: pane.label,
      cwd: paneExecutionCwd(owner, found),
      remote: found.remoteEndpoint !== undefined,
    };
  }
  throw anonymousRefusal();
}

export function registerArtifactCommands(
  registry: CommandRegistry,
  deps: ArtifactCommandDeps,
): () => void {
  const disposers: Array<() => void> = [
    registry.register(publishCommand(deps)),
    registry.register(listCommand(deps)),
    registry.register(readCommand(deps)),
    registry.register(deleteCommand(deps)),
  ];
  return () => {
    for (const dispose of disposers) dispose();
  };
}

function publishCommand(deps: ArtifactCommandDeps): CommandSpec {
  return {
    id: "artifact.publish",
    title:
      "Publish a presentation artifact (HTML or Markdown page) that opens in the user's browser and refreshes live as you iterate. Reach for it when the user asks to show/diagram/visualize something, or when reviewing a design together — the terminal stays the default output channel. The page must be fully self-contained (inline CSS/JS, no external fetches, images as data URIs) because it renders under a strict CSP. Print BOTH urls from the result so the user's scrollback is a recovery surface.",
    args: [
      {
        name: "id",
        type: "string",
        description:
          "The artifact's id — lowercase letters, digits, dashes (e.g. auth-flow). Teammates reference it in mail. Omit to mint one from the title",
      },
      {
        name: "title",
        type: "string",
        required: true,
        description: "Human title (shown in listings and the page header)",
      },
      {
        name: "format",
        type: "string",
        required: true,
        description: "html or md — pinned at first publish",
      },
      {
        name: "path",
        type: "string",
        description:
          "Preferred: a file you wrote (inside the pane's cwd) — .html/.md matching the format",
      },
      {
        name: "content",
        type: "string",
        description:
          "Inline page bytes (≤256 KiB) when a file is not convenient",
      },
      {
        name: "message",
        type: "string",
        description: "One-line changelog for this version (≤500 chars)",
      },
    ],
    run: async (args, source) => {
      const caller = callerContext(source, deps);
      // All arg rules come from the domain module — ONE home per rule,
      // the same home the Rust store mirrors (its caps carry the same
      // names); inline literals here are how the three-homes drift
      // shipped (UTF-16 vs scalars refused different titles).
      const title = str(args, "title");
      if (title === undefined || validateTitle(title) === null) {
        throw new Error(`title must be 1..${TITLE_MAX} chars`);
      }
      const format = str(args, "format");
      if (format === undefined || !isArtifactFormat(format)) {
        throw new Error(`unknown format ${JSON.stringify(String(args.format))} — expected html or md`);
      }
      const path = str(args, "path");
      const content = str(args, "content");
      if (!path && !content) {
        throw new Error("publish needs one of `path` or `content`");
      }
      // Remote and no-cwd panes both lose the path arm — each with the
      // refusal NAMING its own reason (an agent debugging a generic
      // ENOENT never learns the arm is structurally unavailable).
      if (path && caller.remote) {
        throw new Error(
          "this pane runs remotely — path publish is local-only; publish content instead",
        );
      }
      if (path && caller.cwd === null) {
        throw new Error(
          "path publish needs a pane cwd (this pane has none yet) — publish `content` instead",
        );
      }
      const message = str(args, "message");
      // The domain's verdict, not a re-implementation: `.length` counts
      // UTF-16 units and 300 emoji read as 900 there while the domain
      // (and Rust) count scalars — the refusal has one home, in scalars.
      if (message !== undefined && validateMessage(message) === null) {
        throw new Error(`message must be ≤${MESSAGE_MAX} chars`);
      }
      const autoOpen =
        getSettings()?.artifactAutoOpen ?? DEFAULT_SETTINGS.artifactAutoOpen;
      const wire = await artifactPublish({
        workspaceId: caller.workspaceId,
        paneId: caller.paneId,
        label: caller.label,
        cwd: caller.cwd,
        slug: str(args, "id"),
        title,
        format,
        path,
        content,
        message,
        autoOpen,
      });
      if (wire.isNew && deps.announce) {
        deps.announce({
          kind: "published",
          workspaceId: caller.workspaceId,
          workspaceInstance: caller.workspaceInstance,
          slug: wire.slug,
          paneLabel: caller.label,
        });
      }
      return {
        url: wire.url,
        indexUrl: wire.indexUrl,
        id: wire.slug,
        version: wire.version,
        // `isNew` stays OFF the agent wire (the design's drop-it rule —
        // the announce above already gates on it via the IPC result).
        note: wire.url
          ? "published — print both urls; the page refreshes on every republish"
          : "published, but the display server is off — the artifact is stored and listed; say the id and title",
      };
    },
  };
}

function listCommand(deps: ArtifactCommandDeps): CommandSpec {
  return {
    id: "artifact.list",
    title:
      "List this workspace's artifacts (id, title, format, versions, last author) — the team's shared review surface",
    args: [],
    run: async (_args, source) => {
      const caller = callerContext(source, deps);
      const artifacts = await artifactList({
        workspaceId: caller.workspaceId,
      });
      return {
        artifacts,
        note:
          artifacts.length > 0
            ? "read one with artifact_read — id + version"
            : "nothing published in this workspace yet",
      };
    },
  };
}

function readCommand(deps: ArtifactCommandDeps): CommandSpec {
  return {
    id: "artifact.read",
    title:
      "Read an artifact's content (inline under the size cap; above it, metadata + where to open it) for review or iteration",
    args: [
      { name: "id", type: "string", required: true, description: "The artifact's id" },
      {
        name: "version",
        type: "string",
        description: "Version number; default latest",
      },
    ],
    run: async (args, source) => {
      const caller = callerContext(source, deps);
      const id = str(args, "id");
      if (!id) throw new Error("read needs an id");
      const versionText = str(args, "version");
      if (versionText !== undefined && !/^\d+$/.test(versionText)) {
        // Junk is not silence: an agent asking for version 'abc' meant
        // SOMETHING — answering latest silently could review the wrong
        // version (the teach-don't-guess discipline).
        throw new Error("version must be a number — omit it for latest");
      }
      const version =
        versionText !== undefined ? Number(versionText) : undefined;
      return await artifactRead({
        workspaceId: caller.workspaceId,
        slug: id,
        version,
      });
    },
  };
}

function deleteCommand(deps: ArtifactCommandDeps): CommandSpec {
  return {
    id: "artifact.delete",
    title:
      "Delete an artifact (all versions). Only on EXPLICIT instruction from the user or a teammate's request — never as self-directed cleanup. Idempotent: deleting an absent artifact is a no-op",
    args: [
      { name: "id", type: "string", required: true, description: "The artifact's id" },
    ],
    run: async (args, source) => {
      const caller = callerContext(source, deps);
      const id = str(args, "id");
      if (!id) throw new Error("delete needs an id");
      const outcome = await artifactDelete({
        workspaceId: caller.workspaceId,
        slug: id,
      });
      if (outcome.deleted && deps.announce) {
        deps.announce({
          kind: "deleted",
          workspaceId: caller.workspaceId,
          workspaceInstance: caller.workspaceInstance,
          slug: id,
          paneLabel: caller.label,
        });
      }
      return outcome;
    },
  };
}
