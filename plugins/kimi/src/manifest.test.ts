import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderKimiMail } from "./status";
import { present } from "@keepdeck/plugin-api/testing";

/**
 * kimi arms its hooks from a SHIPPED manifest rather than from code, so
 * nothing type-checks it and nothing else in this suite reads it. That is
 * exactly why it is pinned here: the reporter is silent on failure, so a
 * wrong command in this file stops status — or mail — with no error
 * anywhere.
 */
const manifest: { hooks: { event: string; command: string; timeout: number }[] } =
  JSON.parse(
    readFileSync(
      new URL(
        "../resources/keepdeck-session-reporter/kimi.plugin.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );

const commandFor = (event: string) =>
  manifest.hooks.find((hook) => hook.event === event)?.command;

describe("kimi companion manifest", () => {
  it("asks the deck back only where an answer can be acted on", () => {
    // Text returned from UserPromptSubmit is appended to the turn, and that
    // hook runs only for the user's own prompts — the main agent's. Stop
    // could carry mail too, but it fires for subagents with no agent
    // identity, so mail handed out there could land in a subagent. The rest
    // report a fact and read nothing back.
    expect(commandFor("UserPromptSubmit")).toBe(
      "/bin/sh ./kd-status-hook.sh kimi --ask",
    );
    for (const event of ["Stop", "StopFailure", "Interrupt", "PermissionRequest", "PermissionResult"]) {
      expect(commandFor(event), event).toBe("/bin/sh ./kd-status-hook.sh kimi");
    }
  });

  it("arms exactly the events its renderer can answer", () => {
    // kimi declares its arming in a shipped JSON and its rendering in code,
    // so the two can only be held together from outside. Armed but
    // unrendered: the reporter waits out its whole window on every fire and
    // the deck takes messages out of the queue to put them straight back.
    // Rendered but unarmed: that event's mail falls back to a terminal nudge
    // somebody pays a turn for. Both are silent.
    const messages = [
      { id: "mail-1", kind: "task", body: "take the parser", from: "lead" },
    ];
    for (const hook of manifest.hooks) {
      const rendered = renderKimiMail({
        event: { hook_event_name: hook.event },
        messages,
        cliVersion: null,
      });
      expect(
        rendered !== null,
        `${hook.event}: armed=${hook.command.includes("--ask")}, renders=${rendered !== null}`,
      ).toBe(hook.command.includes("--ask"));
    }
  });

  it("claims no mid-turn channel, because kimi has none", () => {
    // The one agent of the four a person cannot correct while it works, and
    // the manifest says so by leaving `mail.mid-turn` out — Settings then
    // renders "Not supported" from the catalog the other three build.
    //
    // Pinned because absence is silent, and because the temptation to "fix"
    // it by declaring the feature would produce a page that lies. What is
    // missing is not the declaration: kimi discards the stdout of every
    // observation-only hook (`void fireAndForgetTrigger`, both engines), so
    // only two of its twenty events reach the model at all, and neither is
    // mid-turn. The routes that exist — a running turn steered over kimi
    // web's REST, or the unmerged PR that would let PreToolUse stdout in —
    // are outside this pane: one needs the pane to stop being a terminal
    // session, the other is somebody else's patch.
    const declared: {
      contributes: { agents: { features?: { id: string }[] }[] };
    } = JSON.parse(
      readFileSync(new URL("../manifest.json", import.meta.url), "utf8"),
    );
    const ids = declared.contributes.agents.flatMap((agent) =>
      (agent.features ?? []).map((feature) => feature.id),
    );
    expect(ids).toContain("mail.turn-end");
    expect(ids).not.toContain("mail.mid-turn");
  });

  it("keeps identity on its own reporter, which never asks", () => {
    // The session hook answers a different question entirely and takes no
    // reply; arming it to ask would make it wait for a file nobody writes.
    expect(commandFor("SessionStart")).toBe("/bin/sh ./kd-session-hook.sh kimi");
  });

  it("leaves every hook room to wait for the deck", () => {
    // The ask loop waits ~2s before giving up. A timeout below that would
    // kill the hook mid-wait and mail would never arrive — and kimi
    // enforces its timeout with a signal, so the reporter would die rather
    // than degrade.
    for (const hook of manifest.hooks) {
      expect(hook.timeout, hook.event).toBeGreaterThanOrEqual(5);
    }
  });

  it("arms NO SessionStart ask, because kimi throws that result away", () => {
    // Measured in the shipped 0.34.0 binary: `triggerSessionStart` awaits
    // the hook and never reads its result, and the docs call the event
    // observation-only. Arming it to ask would make the reporter wait two
    // seconds at every session start to be ignored.
    expect(commandFor("SessionStart")).not.toContain("--ask");
  });
});

/**
 * The SECOND companion, and the only door Kimi has into a starting session.
 *
 * A plugin session-start skill is injected as `<plugin_session_start>` before
 * the first turn, which is how a Kimi pane can learn it is on a team without
 * anybody messaging it first. Nothing type-checks this file either, and a
 * plugin whose sessionStart names a skill that is not there fails with a
 * warning in Kimi's own log — somewhere nobody looks.
 */
describe("kimi teams manifest", () => {
  const teams: {
    name: string;
    skills?: string;
    sessionStart?: { skill?: string };
    hooks?: unknown[];
  } = JSON.parse(
    readFileSync(
      new URL("../resources/keepdeck-teams/kimi.plugin.json", import.meta.url),
      "utf8",
    ),
  );

  it("points its session start at a skill that exists on disk", () => {
    expect(teams.sessionStart?.skill).toBe("keepdeck-team");
    const skill = readFileSync(
      new URL(
        `../resources/keepdeck-teams/skills/${present(teams.sessionStart, "the sessionStart of teams").skill}/SKILL.md`,
        import.meta.url,
      ),
      "utf8",
    );
    // Kimi resolves a skill by its DIRECTORY name; the front matter has to
    // agree or the registry lookup the injector does comes back empty.
    expect(skill).toContain(`name: ${present(teams.sessionStart, "the sessionStart of teams").skill}`);
    // The one thing the text must actually make happen: a pane cannot be
    // told its role statically, so it has to go and ask.
    expect(skill).toContain("mail.inbox");
    // And it must not restate a rule it cannot derive. Static prose is the
    // one surface `kindGuidance` cannot compose, so a copy of that sentence
    // here has no way of following the rule when it changes — this file
    // promised an interrupt for a whole release after delivery stopped
    // reading the kind. It points at the tool's description instead.
    expect(skill).not.toContain("interrupt");
  });

  it("declares where its skills live, since they are not in the plugin root", () => {
    expect(teams.skills).toBe("./skills/");
  });

  it("owns no hooks — those are the reporter's zone", () => {
    // Two plugins, two jobs. Arming a hook here would put turn-lifecycle
    // reporting in two places, and the deck would hear every edge twice.
    expect(teams.hooks).toBeUndefined();
  });
});
