import { repoTrouble } from "../domain/repoState";
import { troubleText } from "../presentation/troubleView";

/** A failed read where a list would have been: the state in the tab's words
 * (`troubleText`), with git's own words on hover for whoever has to debug
 * it. One element for the tab, the History section and the peek's rail, so
 * a failure reads the same wherever it lands. */
export function Trouble({ error }: { error: string }) {
  return (
    <div className="git__empty git__empty--bad" title={error}>
      {troubleText(repoTrouble(error))}
    </div>
  );
}
