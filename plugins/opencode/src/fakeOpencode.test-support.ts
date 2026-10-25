import type { PluginSessionEvent, PluginSqlite } from "@keepdeck/plugin-api";
import type { CommandRun } from "./exec";
import type { OpeningPorts } from "./opening";

/**
 * A fake opencode behind the host's ports, for the fork and the session
 * check: it answers `export` and `import` the way each generation was
 * measured to (task-457, /tmp/kd-task378/isolated), over an in-memory store
 * of exported documents.
 *
 * Measured, and kept here on purpose:
 * - 1.x prints `Exporting session:` ahead of the payload, its `Error:` in
 *   colour, and says `Imported session: <id>` for ANY import — a re-import
 *   of an existing id included, which moves that session to the import's
 *   directory.
 * - 2.x prints the payload alone, and answers an existing id with exit 0 and
 *   `Session already exists`.
 */

/** 1.x's colour codes around `Error:`, as captured. */
export const V1_ERROR = "\x1b[91m\x1b[1mError: \x1b[0m";

export interface FakeRun {
  args: readonly string[];
  cwd?: string;
}

export interface FakeOpencodeOptions {
  generation: 1 | 2;
  /** The store: session id → its exported document. */
  sessions?: Record<string, unknown>;
  /** Bend one command: an answer here replaces the fake opencode's own. */
  answer?: (run: FakeRun) => CommandRun | undefined;
  /** A command that never exits. */
  hang?: (run: FakeRun) => boolean;
  /** Whether a directory exists; all do by default. */
  exists?: (path: string) => boolean;
  /** The store's SQL; by default there is none to read. */
  sqlite?: PluginSqlite;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const infoOf = (document: unknown): Record<string, unknown> =>
  isRecord(document) && isRecord(document.info) ? document.info : {};

export function fakeOpencode(options: FakeOpencodeOptions) {
  const sessions = new Map(Object.entries(options.sessions ?? {}));
  const files = new Map<string, string>();
  const removed: string[] = [];
  const runs: FakeRun[] = [];
  const warns: string[] = [];
  const kills = { count: 0 };
  const v1 = options.generation === 1;

  const exportOf = (id: string): CommandRun => {
    const document = sessions.get(id);
    if (v1) {
      return document === undefined
        ? { text: `Exporting session: ${id}\r\n${V1_ERROR}Session not found: ${id}\r\n`, code: 1 }
        : { text: `Exporting session: ${id}\r\n${JSON.stringify(document, null, 2)}\r\n`, code: 0 };
    }
    return document === undefined
      ? { text: `Session not found: ${id}\r\n`, code: 1 }
      : { text: `${JSON.stringify(document, null, 2)}\r\n`, code: 0 };
  };

  const importOf = (file: string, directory: string): CommandRun => {
    const document: unknown = JSON.parse(files.get(file) ?? "null");
    const id = infoOf(document).id;
    if (typeof id !== "string") return { text: "Missing key\r\n  at [\"id\"]\r\n", code: 1 };
    if (!v1 && sessions.has(id)) return { text: "Session already exists\r\n", code: 0 };
    const placed = structuredClone(document);
    const info = infoOf(placed);
    if (v1) info.directory = directory;
    else info.location = { directory };
    sessions.set(id, placed);
    return { text: `Imported session: ${id}\r\n`, code: 0 };
  };

  const opencode = (run: FakeRun): CommandRun => {
    const bent = options.answer?.(run);
    if (bent) return bent;
    const [first, second, third] = run.args;
    if (v1 && first === "export" && second) return exportOf(second);
    if (v1 && first === "import" && second) return importOf(second, run.cwd ?? "");
    if (!v1 && first === "session" && second === "export" && third) return exportOf(third);
    if (!v1 && first === "session" && second === "import" && third) {
      const directory = run.args[run.args.indexOf("--directory") + 1] ?? "";
      return importOf(third, directory);
    }
    return { text: `unknown command ${run.args.join(" ")}\r\n`, code: 1 };
  };

  const ports: OpeningPorts = {
    log: { warn: (message) => void warns.push(message) },
    services: {
      sessions: {
        spawn: async (spawned, onEvent: (event: PluginSessionEvent) => void) => {
          const run: FakeRun = { args: spawned.args ?? [], ...(spawned.cwd ? { cwd: spawned.cwd } : {}) };
          runs.push(run);
          if (!options.hang?.(run)) {
            queueMicrotask(() => {
              const { text, code } = opencode(run);
              onEvent({ type: "output", bytes: new TextEncoder().encode(text) });
              onEvent({ type: "exit", code });
            });
          }
          return {
            id: "h",
            write: async () => {},
            resize: async () => {},
            close: async () => void (kills.count += 1),
          };
        },
      },
      fs: {
        readDir: async (path) => {
          if (options.exists && !options.exists(path)) throw new Error(`ENOENT: ${path}`);
          return [];
        },
      },
      fsWrite: {
        writeFile: async (path, text) => void files.set(path, text),
        remove: async (path) => {
          removed.push(path);
          files.delete(path);
        },
      },
      sqlite: options.sqlite ?? {
        query: async () => {
          throw new Error("no opencode store");
        },
      },
    },
  };

  return { ports, sessions, files, removed, runs, warns, kills };
}

/**
 * A 1.x export, shaped as 1.19.3 printed one (isolated/v1193/export-source):
 * a user turn and the finished answer that names it as its parent.
 */
export function v1Session(id: string, directory: string) {
  return {
    info: {
      id,
      slug: "fork-source",
      projectID: "global",
      directory,
      title: "source",
      version: "1.19.3",
      time: { created: 1792899000000, updated: 1792899558702 },
    },
    messages: [
      {
        info: {
          id: "msg_f2461db4d001rzij8gRRPwcFG1",
          sessionID: id,
          role: "user",
          time: { created: 1792899000100 },
        },
        parts: [
          {
            id: "prt_f2461db4d001aaAAaaAAaaAA00",
            sessionID: id,
            messageID: "msg_f2461db4d001rzij8gRRPwcFG1",
            type: "text",
            text: "source user turn",
          },
        ],
      },
      {
        info: {
          id: "msg_f2461db59001yU4L8wO2GP6bj9",
          sessionID: id,
          role: "assistant",
          parentID: "msg_f2461db4d001rzij8gRRPwcFG1",
          time: { created: 1792899000200, completed: 1792899000300 },
        },
        parts: [
          {
            id: "prt_f2461db59001bbBBbbBBbbBB00",
            sessionID: id,
            messageID: "msg_f2461db59001yU4L8wO2GP6bj9",
            type: "text",
            text: "source answer",
          },
        ],
      },
    ],
  };
}

/**
 * A 2.x export, shaped as 2.1.4 printed one (isolated/v214/export-source):
 * flat messages; a tool call's id and a shell's id that are not message ids.
 */
export function v2Session(id: string, directory: string) {
  return {
    info: {
      id,
      projectID: "18cba9d94602846eb9cd65028e26e6c4d43ec0c1",
      time: { created: 1792899000000, updated: 1792899357004 },
      title: "source",
      subpath: "../A",
      location: { directory },
    },
    messages: [
      { id: "msg_f2461db4d001rzij8gRRPwcFG1", time: { created: 1792899000100 }, text: "What is 2 + 2?", type: "user" },
      {
        id: "msg_f2461db59001yU4L8wO2GP6bj9",
        time: { created: 1792899000200, completed: 1792899000600 },
        type: "assistant",
        agent: "build",
        content: [
          { type: "text", text: "4." },
          { type: "tool", id: "call_task457_same", name: "read", executed: true },
        ],
        snapshot: { start: "snap_start", end: "snap_end", files: ["note.txt"] },
      },
      {
        id: "msg_f2461db5a001shELLshELLsh00",
        time: { created: 1792899000700, completed: 1792899000800 },
        type: "shell",
        shellID: "sh_task457_same",
        command: "printf done",
      },
    ],
  };
}
