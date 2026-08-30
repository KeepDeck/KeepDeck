import type {
  Disposable,
  DownloadState,
  FsEntry,
  FsFile,
  GitBranches,
  GitChangedFile,
  GitHistory,
  GitStatus,
  PluginContext,
  PluginExecOutcome,
  PluginFs,
  PluginSessionEvent,
  SpeechCapture,
  SpeechCaptureOptions,
} from "@keepdeck/plugin-api";
import { createSessionStore } from "@keepdeck/plugin-api";
import { describeError } from "./errors";
import { RemoteDownloadStream } from "./downloadStream";
import { speechLevelChannel } from "./protocol";
import type { GuestRpc } from "./rpc";

/**
 * The `services` half of the guest context: one proxy per member, each a thin
 * `rpc.call` where the built-in tier would touch a live backend. Like the
 * host's own service table this is a LIST rather than logic — a new member is
 * one line and nothing else.
 *
 * What is NOT a list stays visible here: the four members that keep local
 * state. A spawned session must hold its `onEvent` on this side (a function
 * cannot cross the wire) and flush what arrived before the listener existed;
 * a watch keeps its callback; a download keeps its stream; a capture keeps
 * its channel. Those registries belong to the bridge's lifetime, so they are
 * passed in rather than owned here — this file holds the surface, the context
 * holds the teardown.
 */
export interface GuestServiceDeps {
  rpc: GuestRpc;
  noop: () => void;
  sessionListeners: Map<string, (event: PluginSessionEvent) => void>;
  /** Output can arrive before `spawn` resolves and installs the listener. */
  sessionBuffers: Map<string, PluginSessionEvent[]>;
  remoteWatch: (
    service: "fs" | "git",
    path: string,
    onChange: () => void,
  ) => Disposable;
  downloadStreams: Map<string, RemoteDownloadStream>;
  speechLevels: Map<string, (level: number) => void>;
  /** The same counter that mints registration ids — one id space for
   * everything the host retains on our behalf. */
  mintId: () => number;
}

export function createGuestServices({
  rpc,
  noop,
  sessionListeners,
  sessionBuffers,
  remoteWatch,
  downloadStreams,
  speechLevels,
  mintId,
}: GuestServiceDeps): PluginContext["services"] {
  /** Named so the session-store reader can be built on it — see the return
   * below: the reader runs HERE, in the guest, over this proxy. */
  const fs: PluginFs = {
    readDir: (path) =>
      rpc.call("services.fs.readDir", [path]) as Promise<FsEntry[]>,
    readFile: (path, opts) =>
      rpc.call("services.fs.readFile", [path, opts]) as Promise<FsFile>,
    watch: (path, onChange) => remoteWatch("fs", path, onChange),
  };

  return {
    sessions: {
      spawn: (opts, onEvent) =>
        (rpc.call("services.sessions.spawn", [opts]) as Promise<{ id: string }>).then(
          ({ id }) => {
            sessionListeners.set(id, onEvent);
            // Flush anything that arrived before this listener existed.
            const buffered = sessionBuffers.get(id);
            if (buffered) {
              sessionBuffers.delete(id);
              for (const event of buffered) onEvent(event);
            }
            return {
              id,
              write: (data) =>
                rpc.call("services.sessions.write", [id, data]).then(noop),
              resize: (cols, rows) =>
                rpc.call("services.sessions.resize", [id, cols, rows]).then(noop),
              close: () => {
                sessionListeners.delete(id);
                return rpc.call("services.sessions.close", [id]).then(noop);
              },
            };
          },
        ),
    },
    ports: {
      allocate: (key) =>
        rpc.call("services.ports.allocate", [key]) as Promise<number>,
    },
    opener: {
      openUrl: (url) => rpc.call("services.opener.openUrl", [url]).then(noop),
      openPath: (path) => rpc.call("services.opener.openPath", [path]).then(noop),
      openPathWith: (path, application) =>
        rpc.call("services.opener.openPathWith", [path, application]).then(noop),
    },
    fs,
    // NOT an RPC verb, deliberately. The reader is host code either way; run
    // behind the wire it would have to ship every record across the realm
    // boundary — tens of thousands of messages for one store, and the
    // external tier would be slower for using the memory-safe path. Run
    // HERE it costs one message per window, and the records never leave the
    // realm that asked for them.
    sessionStore: createSessionStore(fs),
    fsWrite: {
      mkdir: (path) =>
        rpc.call("services.fsWrite.mkdir", [path]) as Promise<void>,
      copyFile: (src, dst) =>
        rpc.call("services.fsWrite.copyFile", [src, dst]) as Promise<void>,
      writeFile: (path, text) =>
        rpc.call("services.fsWrite.writeFile", [path, text]) as Promise<void>,
      appendLine: (path, line) =>
        rpc.call("services.fsWrite.appendLine", [path, line]) as Promise<void>,
    },
    sqlite: {
      query: (dbPath, sql, params) =>
        rpc.call("services.sqlite.query", [dbPath, sql, params]) as Promise<
          (string | null)[][]
        >,
    },
    git: {
      status: (repo) =>
        rpc.call("services.git.status", [repo]) as Promise<GitStatus>,
      diffFile: (repo, file, opts) =>
        rpc.call("services.git.diffFile", [repo, file, opts]) as Promise<string>,
      history: (repo, opts) =>
        rpc.call("services.git.history", [repo, opts]) as Promise<GitHistory>,
      branches: (repo) =>
        rpc.call("services.git.branches", [repo]) as Promise<GitBranches>,
      changedFiles: (repo, from, to) =>
        rpc.call("services.git.changedFiles", [repo, from, to]) as Promise<
          GitChangedFile[]
        >,
      watch: (repo, onChange) => remoteWatch("git", repo, onChange),
    },
    downloads: {
      start: (request) => {
        if (downloadStreams.has(request.id)) {
          throw new Error(`download id already used: ${request.id}`);
        }
        let stream!: RemoteDownloadStream;
        stream = new RemoteDownloadStream(() => {
          if (downloadStreams.get(request.id) === stream) {
            downloadStreams.delete(request.id);
          }
        });
        downloadStreams.set(request.id, stream);
        void rpc.call("services.downloads.start", [request]).catch((error) => {
          downloadStreams.delete(request.id);
          const failed: DownloadState = {
            id: request.id,
            phase: "failed",
            received: 0,
            total: request.integrity?.bytes ?? null,
            error: describeError(error),
          };
          stream.push(failed);
        });
        return stream;
      },
      cancel: (id) => rpc.call("services.downloads.cancel", [id]).then(noop),
      exists: (target, integrity) =>
        rpc.call("services.downloads.exists", [target, integrity]) as Promise<boolean>,
      remove: (target) =>
        rpc.call("services.downloads.remove", [target]).then(noop),
    },
    clipboard: {
      writeText: (text) =>
        rpc.call("services.clipboard.writeText", [text]) as Promise<void>,
      readText: () =>
        rpc.call("services.clipboard.readText", []) as Promise<string>,
    },
    exec: {
      runOnce: (request) =>
        rpc.call("services.exec.runOnce", [request]) as Promise<PluginExecOutcome>,
    },
    speech: {
      engines: () =>
        rpc.call("services.speech.engines", []) as ReturnType<
          PluginContext["services"]["speech"]["engines"]
        >,
      async startCapture(onLevel) {
        const id = mintId();
        const channel = speechLevelChannel(id);
        if (onLevel) speechLevels.set(channel, onLevel);
        try {
          await rpc.call("services.speech.start", [id]);
        } catch (error) {
          speechLevels.delete(channel);
          throw error;
        }
        let active = true;
        const close = () => {
          active = false;
          speechLevels.delete(channel);
        };
        const capture: SpeechCapture = {
          async stop(opts: SpeechCaptureOptions) {
            if (!active) throw new Error("speech capture is already closed");
            close();
            return rpc.call("services.speech.stop", [id, opts]) as ReturnType<
              SpeechCapture["stop"]
            >;
          },
          async cancel() {
            if (!active) return;
            close();
            await rpc.call("services.speech.cancel", [id]);
          },
        };
        return capture;
      },
    },
  };
}
