import { Dropdown } from "@keepdeck/ui-kit";
import { scopeWorkspace, type ScopeOptionView, type StatsScopeView } from "../../presentation/stats/statsScopeView";
import { RemoveButton } from "../../ui/RemoveButton";

/** The workspace scope beside the period switcher: the menu its view
 * settles (presentation/stats/statsScopeView.ts), and the way back to
 * every workspace beside it. */
export function StatsScope({ scope, onPick }: { scope: StatsScopeView; onPick(workspace: string | null): void }) {
  return (
    <div className="stats__scope">
      <Dropdown
        options={scope.options.map((option) => ({ value: option.value, label: <ScopeOption option={option} />, current: option.name }))}
        value={scope.value}
        onChange={(value) => onPick(scopeWorkspace(value))}
        ariaLabel={scope.label}
        size="sm"
        disabled={scope.idle}
        note={scope.note}
      />
      {scope.clear !== null && <RemoveButton label={scope.clear} onClick={() => onPick(null)} />}
    </div>
  );
}

function ScopeOption({ option }: { option: ScopeOptionView }) {
  return (
    <span className="stats__scope-option">
      <span className="stats__scope-name">{option.name}</span>
      {option.kind === "spent" && (
        <>
          <span className="stats__scope-bar" aria-hidden="true">
            <i style={{ width: `${option.bar * 100}%` }} />
          </span>
          <span className="stats__scope-share">{option.share}</span>
        </>
      )}
      {option.kind === "silent" ? (
        <span className="stats__scope-quiet">{option.note}</span>
      ) : (
        <b className="stats__scope-money">{option.money}</b>
      )}
    </span>
  );
}
