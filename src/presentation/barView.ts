/**
 * What the deck bar says about the stage's level, decided apart from the
 * bar: the level itself (the view the controller composes and the bar
 * draws) and every word its level controls speak.
 */

/**
 * Where the stage is, as the bar says it. At the teams level the one door is
 * a new team (null while none can be started). Inside a team: what the team
 * is and where it works, and the door to another member, with the refusal's
 * words when the team is full. The way back up is the workspace crumb's.
 */
export type BarLevel =
  | { kind: "teams"; onAddTeam: (() => void) | null }
  | {
      kind: "team";
      name: string;
      branch: string | null;
      canAddMember: boolean;
      /** The add control's tooltip, which is also where a refusal is explained. */
      addMemberTitle: string;
      onAddMember(): void;
    };

/** The bar's words for its level controls. */
export const BAR_WORDS = {
  addTeam: "+ Team",
  addTeamLabel: "Start a team",
  addTeamTip: "Start a team — with its directory",
  addMember: "+ Member",
  addMemberLabel: "Add a member",
  /** The add-member tip: why it is refused when the team is full. */
  addMemberTip: (full: boolean, max: number) => (full ? `Max ${max} agents on a team` : "Add a member"),
} as const;
