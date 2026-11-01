import { useStagingTrims } from "../../app/useStagingTrims";
import { STAGING_TRIMS_TITLE, stagingTrimLines } from "../../presentation/stagingTrimsView";
import { HintList } from "./HintList";

/** The skills staging could not hand agents whole, and why — a skill too
 * large, a link out of one. Nothing while there is none. */
export function StagingTrims() {
  return <HintList title={STAGING_TRIMS_TITLE} lines={stagingTrimLines(useStagingTrims())} />;
}
