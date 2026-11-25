// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isJsonRecord } from "@keepdeck/plugin-api";
import { useHost } from "../../testing/host/host";
import { startDeck, type Deck } from "../../testing/host/deck";

/**
 * Who may use the deck's MCP server, end to end on the app itself: the
 * socket door asks the sessions machine of every line whether its caller
 * runs in a live pane's terminal whose session holds the secret it named. A
 * pane's agent is served and journaled under its pane; a program outside
 * every pane, and what a closed pane left behind, are refused before the
 * page hears of them.
 */
describe("the deck's MCP callers, on the host", () => {
  const host = useHost();
  let deck: Deck | null = null;

  afterEach(() => {
    deck?.dispose();
    deck = null;
  });

  /** The socket the transport confirmed. */
  const socketOf = async (d: Deck): Promise<string> => {
    await host().until("the MCP socket is up", () => d.runtime.mcp.status().socket !== null, 15_000);
    const socket = d.runtime.mcp.status().socket;
    if (socket === null) throw new Error("no socket");
    return socket;
  };

  /** One reply line, parsed. */
  const parsed = (line: string): Record<string, unknown> => {
    const reply: unknown = JSON.parse(line);
    if (!isJsonRecord(reply)) throw new Error(`not a JSON-RPC reply: ${line}`);
    return reply;
  };

  /** The refusal's reason in a reply, or null for a reply that is none. */
  const reasonOf = (reply: Record<string, unknown>): unknown => {
    const error = reply.error;
    if (!isJsonRecord(error)) return null;
    expect(error.code).toBe(-32001);
    return isJsonRecord(error.data) ? error.data.reason : null;
  };

  /** Lines sent from this test's own process, which runs in no pane's
   * terminal: the one line that answers them. */
  const askFromOutside = (socket: string, lines: string[]) =>
    new Promise<string>((resolve, reject) => {
      const connection = connect(socket);
      let buffer = "";
      connection.setEncoding("utf8");
      connection.on("connect", () => connection.write(lines.map((line) => `${line}\n`).join("")));
      connection.on("data", (chunk: string) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        connection.destroy();
        resolve(buffer.slice(0, end));
      });
      connection.on("error", reject);
    });

  const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

  it("serves a pane's agent by its pane's secret, and journals the call under that pane", async () => {
    const d = (deck = await startDeck(host()));
    const { paneId } = await d.agentUp();
    const socket = await socketOf(d);
    const call = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "workspace_list", arguments: {} } });

    d.type(paneId, `mcp ${socket} ${call}`);
    await host().until("the agent's call is answered", () => d.output(paneId).includes("stub: mcp "), 15_000);

    const answer = d.output(paneId).split("stub: mcp ")[1]?.split("\r\n")[0] ?? "";
    const reply = parsed(answer);
    expect(reply.id).toBe(7);
    expect(reasonOf(reply)).toBeNull();
    expect(isJsonRecord(reply.result) && reply.result.isError).toBe(false);
    const journal = d.journal();
    expect(journal[journal.length - 1]).toMatchObject({
      commandId: "workspace.list",
      source: { kind: "external", client: "mcp", pane: { id: paneId } },
    });
  });

  it("refuses a program outside every pane already at initialize, secret or none", async () => {
    const d = (deck = await startDeck(host()));
    await d.agentUp();
    const socket = await socketOf(d);
    const before = d.journal().length;

    expect(reasonOf(parsed(await askFromOutside(socket, [INITIALIZE])))).toBe("no-secret");
    // A secret from outside the terminal names nobody: the terminal comes
    // first, whatever the secret.
    const greeting = JSON.stringify({ jsonrpc: "2.0", method: "deck/client", params: { token: "any-secret" } });
    expect(reasonOf(parsed(await askFromOutside(socket, [greeting, INITIALIZE])))).toBe("outside-terminal");
    expect(d.journal().length).toBe(before);
  });

  it("refuses what a closed pane left behind on the connection it was served on, its secret and all", async () => {
    // A daemon the agent started keeps the pane's environment, secret
    // included, and outlives the pane. While the agent runs it is the
    // pane's, and served; once the pane is closed the same connection is
    // refused: an admission is never kept for a connection, every line is
    // judged as it arrives.
    const d = (deck = await startDeck(host()));
    const { paneId } = await d.agentUp();
    const socket = await socketOf(d);
    const answerTo = join(host().work, "lingered.json");

    d.type(paneId, `linger ${socket} ${answerTo}`);
    await host().until("the daemon is served while its pane lives", () => existsSync(`${answerTo}.held`), 15_000);
    const held = parsed(readFileSync(`${answerTo}.held`, "utf8"));
    expect(reasonOf(held)).toBeNull();
    expect(isJsonRecord(held.result) && held.result.protocolVersion).toBeTruthy();

    await d.closeAgent(paneId);
    await host().until("the leftover has asked again", () => existsSync(answerTo), 15_000);
    expect(reasonOf(parsed(readFileSync(answerTo, "utf8")))).toBe("outside-terminal");
  });
});
