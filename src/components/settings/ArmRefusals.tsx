import { useAgents } from "../../app/useAgents";
import { useArmRefusals } from "../../app/useArmRefusals";
import { ARM_REFUSALS_TITLE, armRefusalLines } from "../../presentation/armRefusalsView";

/** The folders where an agent's plugin could not plant what its pane needs,
 * under the agent's name — the one place a pane silently lacking what the
 * others got is said. Nothing while there is none. */
export function ArmRefusals() {
  const refusals = useArmRefusals();
  const { agents } = useAgents();
  if (refusals.length === 0) return null;
  return (
    <span className="settings__hint kd-selectable">
      {ARM_REFUSALS_TITLE}
      {armRefusalLines(refusals, agents).map((line) => (
        <span key={line.key} className="settings__refusal">
          {line.text}
        </span>
      ))}
    </span>
  );
}
