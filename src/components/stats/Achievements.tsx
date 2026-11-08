import { useMemo } from "react";
import { usageAchievementLadders } from "../../domain/usage/achievements/ladders";
import type { UsageLedger } from "../../domain/usage/history/ledger";
import {
  achievementSections,
  type AchievementCardView,
} from "../../presentation/stats/achievementView";
import { Tooltip } from "../../ui/Tooltip";
import { AchievementEmbers } from "./AchievementEmbers";

/** The achievements tab: the sections and cards its view model settles
 * (presentation/stats/achievementView.ts), rendered. */
export function Achievements({ ledger }: { ledger: UsageLedger }) {
  const sections = useMemo(() => achievementSections(usageAchievementLadders(ledger.events)), [ledger]);
  return (
    <>
      {sections.map((section) => (
        <section className="stats__section" key={section.title}>
          <h3>{section.title}</h3>
          <div className="stats__achievements">
            {section.cards.map((card) => (
              <AchievementCard key={card.id} card={card} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

/** The hover-intent pause before a card's detail tip shows — a grid
 * swept by the cursor must not strobe forty tips. */
const TIP_DELAY_MS = 450;

function AchievementCard({ card }: { card: AchievementCardView }) {
  // The card IS the tip's anchor: the shared Tooltip portals the detail
  // layer, so the scroller can no longer clip it — the flip-above
  // measurement and the paint-order lift died with the in-flow tip.
  return (
    <Tooltip
      className={`stats__achievement stats__achievement--${card.rarity}${
        card.locked ? " stats__achievement--locked" : ""
      }${card.future ? " stats__achievement--future" : ""}`}
      delayMs={TIP_DELAY_MS}
      tip={
        <span
          className={`stats__achievement-tip${
            card.locked ? " stats__achievement-tip--locked" : ""
          }`}
        >
          <b>
            <span className="stats__achievement-tip-icon" aria-hidden>
              {card.icon}
            </span>{" "}
            {card.title}
          </b>
          {/* The card says the level in colour alone; the tip says it in
              words, which is also the version a reader who cannot separate
              those hues gets. */}
          <span>{card.rarityLabel}</span>
          <span>{card.requirement}</span>
          <span>{card.tipStatus}</span>
        </span>
      }
    >
      {/* The rarity's own layers — a running edge, a cut ground, a turning
          spectrum. Which levels light which is decided in the stylesheet;
          the card says which level it is, and — the two things a stylesheet
          cannot know, because they are per-badge — how far THIS badge's edge
          runs off its level's pace and where on the border it starts. Both
          ride on every rim, including the levels that show no runner at all:
          the question of who has one has a single home, and it is not here.
          The rim comes first so its ground sits UNDER the cut and only its
          lit edge shows. */}
      <span
        className="stats__achievement-rim stats__achievement-layer"
        style={{
          "--rim-drift": card.rim.drift,
          "--rim-phase": card.rim.phase,
        }}
        aria-hidden
      />
      <span className="stats__achievement-dress stats__achievement-layer" aria-hidden />
      {card.embers ? <AchievementEmbers /> : null}
      <span className="stats__achievement-icon" aria-hidden>
        {card.icon}
      </span>
      <b>{card.title}</b>
      {/* The card says the level in colour, and the hover tip says it in
          words — but a tip opens on hover alone, so without this the level
          is unavailable to anyone not using a mouse, and to anyone who
          cannot separate those hues. Hidden rather than shown because a
          fifth line of text on fifty badges is noise. */}
      <span className="kd-sr">{card.rarityLabel}</span>
      <small>{card.requirement}</small>
      {card.status.kind === "earned" ? (
        <small className="stats__achievement-earned">{card.status.text}</small>
      ) : card.status.kind === "progress" ? (
        <>
          <span className="stats__achievement-progress" aria-hidden>
            <i style={{ width: `${card.status.percent}%` }} />
          </span>
          <small>{card.status.text}</small>
        </>
      ) : null}
    </Tooltip>
  );
}
