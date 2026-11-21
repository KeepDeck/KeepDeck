// The whole page on the host: the app's own runtime (createAppRuntime), its
// one built-in the stub plugin, against the app itself in the host process.
// Modules are loaded afresh per deck, so each test's page is a page of its
// own — the registry, the settings and the session table included.
import { vi } from "vitest";
import type { AppRuntime } from "../../app/runtime";
import type { Host } from "./host";
import { stubPlugin, type StubAgentControl } from "./stubPlugin";

export interface Deck {
  runtime: AppRuntime;
  /** What the stub agent's next plans do. */
  stub: StubAgentControl;
  dispose(): void;
}

/** Whether the page has heard the machine open its barrier: a lifecycle
 * snapshot that says so, on the pipe the page reads it from. */
function heardOpen(host: Host): boolean {
  return host.tape.some(({ way, line }) => way === "← host" && line.includes('"open":true'));
}

/** Start the page's runtime on `host`, and wait for the machine to open. */
export async function startDeck(host: Host): Promise<Deck> {
  vi.resetModules();
  const { createAppRuntime } = await import("../../app/runtime");
  const { createCommandRegistry } = await import("../../domain/commands/registry");
  const stub: StubAgentControl = { rejectResumes: false, deaf: false };
  const runtime = createAppRuntime(undefined, createCommandRegistry(), () => Promise.resolve([stubPlugin(stub)]));
  runtime.start();
  await host.until("the machine opened its barrier", () => heardOpen(host), 15_000);
  return { runtime, stub, dispose: () => runtime.dispose() };
}
