import type {
  WatchHandle,
  DownloadState,
  PluginContext,
  PluginFs,
  PluginSessionEvent,
  SpeechCapture,
  SpeechCaptureOptions,
  SpeechLevel,
} from "@keepdeck/plugin-api";
import { createSessionStore, errorMessage } from "@keepdeck/plugin-api";

import { RemoteDownloadStream } from "./downloadStream";
import { speechLevelChannel } from "./protocol";
import {
  decodeWith,
  isBoolean,
  isExecOutcome,
  isFsFile,
  isFsEntries,
  isGitBlobAnswer,
  isGitBranches,
  isGitChangedFiles,
  isGitDiff,
  isGitHistory,
  isGitStatus,
  isNumber,
  isRpcAnswer,
  isSessionSpawn,
  isSpeechDevices,
  isSpeechEngines,
  isSpeechStart,
  isSpeechTranscript,
  isSqlAnswer,
  isString,
} from "./decode";
import type { GuestCaller } from "./rpc";

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
  rpc: GuestCaller;
  noop: () => void;
  sessionListeners: Map<string, (event: PluginSessionEvent) => void>;
  /** Output can arrive before `spawn` resolves and installs the listener. */
  sessionBuffers: Map<string, PluginSessionEvent[]>;
  remoteWatch: (
    service: "fs" | "git",
    path: string,
    onChange: () => void,
  ) => WatchHandle;
  downloadStreams: Map<string, RemoteDownloadStream>;
  speechLevels: Map<string, (level: SpeechLevel) => void>;
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
      rpc
        .call("services.fs.readDir", [path])
        .then((value) => decodeWith(value, isFsEntries, "fs entries")),
    readFile: (path, opts) =>
      rpc
        .call("services.fs.readFile", [path, opts])
        .then((value) => decodeWith(value, isFsFile, "fs file")),
    watch: (path, onChange) => remoteWatch("fs", path, onChange),
  };

  return {
    sessions: {
      spawn: (opts, onEvent) =>
        rpc
          .call("services.sessions.spawn", [opts])
          .then((value) => decodeWith(value, isSessionSpawn, "session spawn"))
          .then(
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
        rpc
          .call("services.ports.allocate", [key])
          .then((value) => decodeWith(value, isNumber, "allocated port")),
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
        rpc.call("services.fsWrite.mkdir", [path]).then(noop),
      copyFile: (src, dst, options) =>
        rpc.call("services.fsWrite.copyFile", [src, dst, options]).then(noop),
      remove: (path) =>
        rpc.call("services.fsWrite.remove", [path]).then(noop),
      writeFile: (path, text) =>
        rpc.call("services.fsWrite.writeFile", [path, text]).then(noop),
      appendLine: (path, line) =>
        rpc.call("services.fsWrite.appendLine", [path, line]).then(noop),
    },
    sqlite: {
      query: (dbPath, sql, params) =>
        rpc
          .call("services.sqlite.query", [dbPath, sql, params])
          .then((value) => decodeWith(value, isSqlAnswer, "sql answer")),
    },
    git: {
      status: (repo) =>
        rpc
          .call("services.git.status", [repo])
          .then((value) => decodeWith(value, isGitStatus, "git status")),
      diffFile: (repo, file, opts) =>
        rpc
          .call("services.git.diffFile", [repo, file, opts])
          .then((value) => decodeWith(value, isGitDiff, "git diff")),
      fileAt: (repo, file, rev) =>
        rpc
          .call("services.git.fileAt", [repo, file, rev])
          .then((value) => decodeWith(value, isGitBlobAnswer, "git file")),
      history: (repo, opts) =>
        rpc
          .call("services.git.history", [repo, opts])
          .then((value) => decodeWith(value, isGitHistory, "git history")),
      branches: (repo) =>
        rpc
          .call("services.git.branches", [repo])
          .then((value) => decodeWith(value, isGitBranches, "git branches")),
      changedFiles: (repo, from, to) =>
        rpc
          .call("services.git.changedFiles", [repo, from, to])
          .then((value) => decodeWith(value, isGitChangedFiles, "git changed files")),
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
            error: errorMessage(error),
          };
          stream.push(failed);
        });
        return stream;
      },
      cancel: (id) => rpc.call("services.downloads.cancel", [id]).then(noop),
      exists: (target, integrity) =>
        rpc
          .call("services.downloads.exists", [target, integrity])
          .then((value) => decodeWith(value, isBoolean, "download exists")),
      remove: (target) =>
        rpc.call("services.downloads.remove", [target]).then(noop),
    },
    clipboard: {
      writeText: (text) =>
        rpc.call("services.clipboard.writeText", [text]).then(noop),
      readText: () =>
        rpc
          .call("services.clipboard.readText", [])
          .then((value) => decodeWith(value, isString, "clipboard text")),
    },
    exec: {
      runOnce: (request) =>
        rpc
          .call("services.exec.runOnce", [request])
          .then((value) => decodeWith(value, isExecOutcome, "exec outcome")),
    },
    rpc: {
      request: (call) =>
        rpc
          .call("services.rpc.request", [call])
          .then((value) => decodeWith(value, isRpcAnswer, "rpc answer")),
    },
    speech: {
      engines: () =>
        rpc
          .call("services.speech.engines", [])
          .then((value) => decodeWith(value, isSpeechEngines, "speech engines")),
      devices: () =>
        rpc
          .call("services.speech.devices", [])
          .then((value) => decodeWith(value, isSpeechDevices, "speech devices")),
      async startCapture(onLevel, options) {
        const id = mintId();
        const channel = speechLevelChannel(id);
        if (onLevel) speechLevels.set(channel, (level) => onLevel(level.rms, level));
        let opened: { device: string; deviceMissing: boolean };
        try {
          opened = decodeWith(
            await rpc.call("services.speech.start", [id, options ?? {}]),
            isSpeechStart,
            "speech start",
          );
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
          device: opened.device,
          deviceMissing: opened.deviceMissing,
          async stop(opts: SpeechCaptureOptions) {
            if (!active) throw new Error("speech capture is already closed");
            close();
            return rpc
              .call("services.speech.stop", [id, opts])
              .then((value) => decodeWith(value, isSpeechTranscript, "speech transcript"));
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
