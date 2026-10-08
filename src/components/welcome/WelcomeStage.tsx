import type { AgentInfo } from "../../domain/agents";
import type { SpawnConfig } from "../../domain/deck";
import type { WelcomeFlow } from "../../app/useWelcomeFlow";
import { welcomeView } from "../../presentation/welcomeView";
import { useWallClock } from "../../ui/useWallClock";
import { WorkspaceForm } from "../workspace/WorkspaceForm";
import { useRecentProjects } from "./useRecentProjects";
import { WelcomeScreen } from "./WelcomeScreen";

/**
 * The stage while there is no workspace: the welcome screen, then — a
 * folder chosen — the workspace form confirming it. Wiring only: the steps
 * are `welcomeFlow`'s, the words `welcomeView`'s, the projects the session
 * index's.
 */
export function WelcomeStage({
  flow,
  agents,
  onCreate,
  pickFolder,
  inspectDir,
}: {
  flow: WelcomeFlow;
  agents: readonly AgentInfo[];
  onCreate(config: SpawnConfig): void;
  pickFolder(title: string): Promise<string | null>;
  inspectDir(path: string): Promise<{ isRepo: boolean; branch: string | null }>;
}) {
  const projects = useRecentProjects();
  const now = useWallClock(0, true);
  const { step, showAll } = flow.state;
  if (step.kind === "confirm") {
    return (
      <WorkspaceForm
        // A new folder is a new confirm: the form starts over from it.
        key={step.dir}
        confirm={{ dir: step.dir, onBack: flow.back }}
        onCreate={(config) => {
          flow.reset();
          onCreate(config);
        }}
        pickFolder={pickFolder}
        inspectDir={inspectDir}
      />
    );
  }
  return (
    <WelcomeScreen
      view={welcomeView({ projects, showAll, agents, now })}
      onOpenFolder={flow.openFolder}
      onChoose={flow.choose}
      onShowAll={flow.showAll}
    />
  );
}
