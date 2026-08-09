import type { ArgSpec, CommandArgs, CommandRegistry, CommandSource } from "../../domain/commands";
import { parseSkillFile, type SkillScope } from "../../domain/skills";
import type { SkillsLibrary } from "../skillsLibrary";
import type { Deck } from "../useDeck";

/**
 * The skills library as commands — the CRUD half of the deck's control surface
 * ([skills]). Registered in the core set, not inside a transport, because the
 * registry is the single door every invoker comes through: MCP projects these
 * into tools, and voice, hotkeys and a future palette get them for free.
 *
 * The library itself lives in `skillsLibrary`; these handlers only turn a flat
 * bag of primitives into its calls. Nothing here validates a draft or composes a
 * SKILL.md — that is the owner's, so a skill written through a command is
 * exactly a skill written through the editor.
 *
 * Its own file rather than more lines in `coreCommands/index.ts`, which is
 * already 557 lines of registrations; the remaining areas (workspaces, panes,
 * spawn, surfaces) want the same split, and their suites are already separated
 * that way.
 */

export interface SkillsCommandDeps {
  deck(): Deck;
  skills: SkillsLibrary;
}

const SCOPE: ArgSpec = {
  name: "scope",
  type: "string",
  required: true,
  description:
    'Which library to touch: "global" for every workspace, or "workspace" for the caller\'s own workspace',
};

const NAME: ArgSpec = {
  name: "name",
  type: "string",
  required: true,
  description: "The skill's name — its directory, in kebab-case",
};

const DESCRIPTION: ArgSpec = {
  name: "description",
  type: "string",
  required: true,
  description:
    "One line saying when an agent should reach for this skill — this is what agents select on, so a skill without it never takes effect",
};

const BODY: ArgSpec = {
  name: "body",
  type: "string",
  required: true,
  description:
    "The Markdown instructions an agent reads when the skill triggers, without frontmatter",
};

/** Read `scope` as a library.
 *
 * The workspace arm deliberately takes NO id argument. An external caller is a
 * pane, and a pane belongs to exactly one workspace — letting it name an
 * arbitrary id would let an agent in one workspace write into another's
 * library. A host or plugin caller has no pane, so for them the workspace on
 * screen is the only thing "this workspace" can mean.
 */
function scopeOf(args: CommandArgs, source: CommandSource, deck: () => Deck): SkillScope {
  const scope = args.scope;
  if (scope === "global") return { kind: "global" };
  if (scope !== "workspace") {
    throw new Error(`scope must be "global" or "workspace", not "${String(scope)}"`);
  }
  if (source.kind === "external") {
    if (!source.pane) {
      throw new Error(
        'this client is not tied to a pane, so it has no workspace — use scope "global"',
      );
    }
    return { kind: "workspace", wsId: source.pane.workspaceId };
  }
  const { activeId } = deck();
  if (activeId === null) {
    throw new Error('no workspace is open, so there is no workspace library — use scope "global"');
  }
  return { kind: "workspace", wsId: activeId };
}

/** How a scope reads in a refusal the caller has to act on. */
const scopeLabel = (scope: SkillScope): string =>
  scope.kind === "global" ? "the global library" : `workspace ${scope.wsId}`;

export function registerSkillsCommands(
  registry: CommandRegistry,
  deps: SkillsCommandDeps,
): (() => void)[] {
  const library = deps.skills;
  const scope = (args: CommandArgs, source: CommandSource) =>
    scopeOf(args, source, deps.deck);

  return [
    registry.register({
      id: "skills.list",
      title: "List skills",
      args: [SCOPE],
      run: async (args, source) => {
        const where = scope(args, source);
        // The description is what a caller picks a skill by, so the list is
        // useless without it; the body is not, and would make every listing
        // carry the whole library.
        return (await library.list(where)).map((skill) => ({
          name: skill.name,
          description: parseSkillFile(skill.content).description,
        }));
      },
    }),

    registry.register({
      id: "skills.read",
      title: "Read a skill",
      args: [SCOPE, NAME],
      run: async (args, source) => {
        const where = scope(args, source);
        const name = String(args.name);
        const draft = await library.read(where, name);
        if (!draft) throw new Error(`No skill "${name}" in ${scopeLabel(where)}`);
        // Hand-added frontmatter is deliberately absent: a caller cannot set it
        // through these commands, and an update preserves whatever is there.
        return { name: draft.name, description: draft.description, body: draft.body };
      },
    }),

    registry.register({
      id: "skills.create",
      title: "Create a skill",
      args: [SCOPE, NAME, DESCRIPTION, BODY],
      run: async (args, source) => {
        const where = scope(args, source);
        await library.create(where, {
          name: String(args.name),
          description: String(args.description),
          body: String(args.body),
          extraFrontmatter: [],
        });
        return { name: String(args.name) };
      },
    }),

    registry.register({
      id: "skills.update",
      title: "Update a skill",
      args: [SCOPE, NAME, DESCRIPTION, BODY],
      run: async (args, source) => {
        const where = scope(args, source);
        const name = String(args.name);
        // Read first for two reasons: the write underneath would otherwise
        // CREATE a skill this command promised only to update, and the stored
        // file's hand-added frontmatter has to survive a caller that cannot
        // send those keys back.
        const stored = await library.read(where, name);
        if (!stored) {
          throw new Error(
            `No skill "${name}" in ${scopeLabel(where)} — use skills.create to add it`,
          );
        }
        await library.update(where, {
          ...stored,
          name,
          description: String(args.description),
          body: String(args.body),
        });
        return { name };
      },
    }),

    registry.register({
      id: "skills.rename",
      title: "Rename a skill",
      args: [
        SCOPE,
        {
          name: "from",
          type: "string",
          required: true,
          description: "The skill's current name",
        },
        { name: "to", type: "string", required: true, description: "Its new name" },
      ],
      run: async (args, source) => {
        const where = scope(args, source);
        const from = String(args.from);
        if (!(await library.read(where, from))) {
          throw new Error(`No skill "${from}" in ${scopeLabel(where)}`);
        }
        await library.rename(where, from, String(args.to));
        return { name: String(args.to) };
      },
    }),

    registry.register({
      id: "skills.delete",
      title: "Delete a skill",
      args: [SCOPE, NAME],
      run: async (args, source) => {
        const where = scope(args, source);
        const name = String(args.name);
        if (!(await library.read(where, name))) {
          throw new Error(`No skill "${name}" in ${scopeLabel(where)}`);
        }
        await library.remove(where, name);
        return { name };
      },
    }),
  ];
}
