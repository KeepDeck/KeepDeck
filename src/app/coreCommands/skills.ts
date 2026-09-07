import type { ArgSpec, CommandArgs, CommandRegistry, CommandSource } from "../../domain/commands";
import { skillDraftOf } from "../../domain/skills";
import type { SkillsLibrary } from "../skillsLibrary";
import type { Deck } from "../useDeck";
import { requiredStr, text } from "./args";
import { SCOPE, libraryScopeOf } from "./scope";

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

export function registerSkillsCommands(
  registry: CommandRegistry,
  deps: SkillsCommandDeps,
): (() => void)[] {
  const library = deps.skills;
  // Which library — the rule shared with every other library the deck
  // exposes (see `./scope`).
  const scope = (args: CommandArgs, source: CommandSource) =>
    libraryScopeOf(args, source, deps.deck);

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
        return (await library.list(where)).map((skill) => {
          const draft = skillDraftOf(skill);
          return { name: draft.name, description: draft.description };
        });
      },
    }),

    registry.register({
      id: "skills.read",
      title: "Read a skill",
      args: [SCOPE, NAME],
      run: async (args, source) => {
        // No absence check here: the library refuses a name its scope does not
        // hold, in the same words it uses for an update or a delete. A handler
        // that decided this itself was a second answer to one question, and the
        // two sentences had already drifted apart.
        const draft = await library.read(scope(args, source), requiredStr(args, "name"));
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
        const name = requiredStr(args, "name");
        await library.create(scope(args, source), {
          name,
          description: requiredStr(args, "description"),
          // Verbatim: the body is content, and trimming it would edit what the
          // caller wrote.
          body: text(args, "body"),
          extraFrontmatter: [],
        });
        return { name };
      },
    }),

    registry.register({
      id: "skills.update",
      title: "Update a skill",
      args: [SCOPE, NAME, DESCRIPTION, BODY],
      run: async (args, source) => {
        const name = requiredStr(args, "name");
        // No read here: the library refuses an update of a skill that is not
        // there, and carries over the stored file's other frontmatter itself.
        await library.update(scope(args, source), {
          name,
          description: requiredStr(args, "description"),
          // Verbatim: the body is content, and trimming it would edit what the
          // caller wrote.
          body: text(args, "body"),
          extraFrontmatter: [],
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
        const to = requiredStr(args, "to");
        await library.rename(scope(args, source), requiredStr(args, "from"), to);
        return { name: to };
      },
    }),

    registry.register({
      id: "skills.delete",
      title: "Delete a skill",
      args: [SCOPE, NAME],
      run: async (args, source) => {
        const name = requiredStr(args, "name");
        await library.remove(scope(args, source), name);
        return { name };
      },
    }),
  ];
}
