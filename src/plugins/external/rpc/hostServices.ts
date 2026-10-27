import type {
  Disposable,
  DownloadState,
  PluginContext,
  SpeechCapture,
} from "@keepdeck/plugin-api";
import { downloadChannel, fswatchChannel, speechLevelChannel } from "./protocol";
import type { HostSessions } from "./hostSessions";
import { errorMessage, GIT_DIFF_ANSWER_API } from "@keepdeck/plugin-api";
import {
  decodeCopyOptions,
  decodeDownloadRequest,
  decodeDownloadTarget,
  decodeExecRequest,
  decodeHttpGet,
  decodeRpcCall,
  decodeGitDiffOptions,
  decodeGitHistoryOptions,
  decodeReadFileOptions,
  decodeSpeechOptions,
  decodeSpawnOptions,
  num,
  optional,
  str,
  strArray,
  isDownloadIntegrity,
  isObjectLike,
} from "./decode";

/**
 * The `services.*` half of the dispatch table: thin adaptors from a positional
 * `args` array onto one member of the real `ctx.services`. They are all the
 * same shape and share the same three concerns — decode the wire's arguments,
 * hand them to the context, and for the streaming members keep the host-side
 * handle a guest cannot hold across the wire.
 *
 * They sit apart from the routing core because they are a LIST, not logic: a
 * new service member is one line here and nothing else. What they need from
 * the bridge is passed in rather than closed over, so the core keeps the
 * lifetime and this file keeps the surface.
 */
export interface ServiceHandlerDeps {
  ctx: PluginContext;
  push: (channel: string, payload: unknown) => void;
  sessions: HostSessions;
  /** fs and git watches share one guest-minted id space and one map — a watch
   * is a watch, only the backend differs. */
  watches: Map<number, Disposable>;
  activeDownloads: Set<string>;
  activeSpeechCaptures: Map<number, SpeechCapture>;
  /** Read at CALL time, never captured: the bridge can die while a device is
   * still opening, and the answer must be the state at landing. */
  isDisposed: () => boolean;
}

export function createServiceHandlers({
  ctx,
  push,
  sessions,
  watches,
  activeDownloads,
  activeSpeechCaptures,
  isDisposed,
}: ServiceHandlerDeps): Record<string, (args: unknown[]) => unknown> {
  return {
    "services.exec.runOnce": ([request]) =>
      ctx.services.exec.runOnce(decodeExecRequest(request)),
    "services.rpc.request": ([call]) => ctx.services.rpc.request(decodeRpcCall(call)),
    "services.http.get": ([request]) => ctx.services.http.get(decodeHttpGet(request)),
    "services.env.get": ([name]) => ctx.services.env.get(str(name, "env.get name")),
    "services.ports.allocate": ([key]) =>
      ctx.services.ports.allocate(str(key, "ports.allocate key")),
    "services.opener.openUrl": ([url]) =>
      ctx.services.opener.openUrl(str(url, "opener.openUrl url")),
    "services.opener.openPath": ([path]) =>
      ctx.services.opener.openPath(str(path, "opener.openPath path")),
    "services.opener.openPathWith": ([path, application]) =>
      ctx.services.opener.openPathWith(
        str(path, "opener.openPathWith path"),
        str(application, "opener.openPathWith application"),
      ),
    "services.sessions.spawn": ([opts]) =>
      sessions.spawn(decodeSpawnOptions(opts)),
    "services.sessions.write": ([id, data]) =>
      sessions.write(
        str(id, "sessions.write id"),
        str(data, "sessions.write data"),
      ),
    "services.sessions.resize": ([id, cols, rows]) =>
      sessions.resize(
        str(id, "sessions.resize id"),
        num(cols, "sessions.resize cols"),
        num(rows, "sessions.resize rows"),
      ),
    "services.sessions.close": ([id]) =>
      sessions.close(str(id, "sessions.close id")),
    "services.fs.readDir": ([path]) => ctx.services.fs.readDir(str(path, "fs.readDir path")),
    "services.fs.readFile": ([path, opts]) =>
      ctx.services.fs.readFile(
        str(path, "fs.readFile path"),
        decodeReadFileOptions(opts),
      ),
    // A watch is a subscription: the guest mints the id, the host holds the
    // Disposable under it and pushes `fswatch:<id>` on each change.
    "services.fs.watch": ([id, path]) => {
      const key = num(id, "fs.watch id");
      watches.get(key)?.dispose();
      const handle = ctx.services.fs.watch(str(path, "fs.watch path"), () =>
        push(fswatchChannel(key), undefined),
      );
      watches.set(key, handle);
      // The call answers once the watch is armed, and fails when the host
      // refused it — the guest's handle promises the same on its `ready`.
      return handle.ready;
    },
    "services.sqlite.query": ([dbPath, sql, params]) =>
      ctx.services.sqlite.query(
        str(dbPath, "sqlite.query dbPath"),
        str(sql, "sqlite.query sql"),
        params === undefined ? undefined : strArray(params, "sqlite.query params"),
      ),
    "services.fsWrite.mkdir": ([path]) =>
      ctx.services.fsWrite.mkdir(str(path, "fsWrite.mkdir path")),
    "services.fsWrite.copyFile": ([src, dst, options]) =>
      ctx.services.fsWrite.copyFile(
        str(src, "fsWrite.copyFile src"),
        str(dst, "fsWrite.copyFile dst"),
        decodeCopyOptions(options),
      ),
    "services.fsWrite.remove": ([path]) =>
      ctx.services.fsWrite.remove(str(path, "fsWrite.remove path")),
    "services.fsWrite.writeFile": ([path, text]) =>
      ctx.services.fsWrite.writeFile(
        str(path, "fsWrite.writeFile path"),
        str(text, "fsWrite.writeFile text"),
      ),
    "services.fsWrite.appendLine": ([path, line]) =>
      ctx.services.fsWrite.appendLine(
        str(path, "fsWrite.appendLine path"),
        str(line, "fsWrite.appendLine line"),
      ),
    "services.fsWrite.move": ([src, dst]) =>
      ctx.services.fsWrite.move(str(src, "fsWrite.move src"), str(dst, "fsWrite.move dst")),
    "services.fs.unwatch": ([id]) => {
      const key = num(id, "fs.unwatch id");
      watches.get(key)?.dispose();
      watches.delete(key);
    },
    "services.git.status": ([repo]) =>
      ctx.services.git.status(str(repo, "git.status repo")),
    "services.git.history": ([repo, opts]) =>
      ctx.services.git.history(
        str(repo, "git.history repo"),
        decodeGitHistoryOptions(opts),
      ),
    "services.git.fileAt": ([repo, file, rev]) =>
      ctx.services.git.fileAt(
        str(repo, "git.fileAt repo"),
        str(file, "git.fileAt file"),
        optional(rev, (value): value is string => typeof value === "string", "git.fileAt rev"),
      ),
    "services.git.branches": ([repo]) =>
      ctx.services.git.branches(str(repo, "git.branches repo")),
    "services.git.changedFiles": ([repo, from, to]) =>
      ctx.services.git.changedFiles(
        str(repo, "git.changedFiles repo"),
        str(from, "git.changedFiles from"),
        optional(to, (value): value is string => typeof value === "string", "git.changedFiles to"),
      ),
    "services.git.diffFile": ([repo, file, opts]) => {
      const answer = ctx.services.git.diffFile(
        str(repo, "git.diffFile repo"),
        str(file, "git.diffFile file"),
        decodeGitDiffOptions(opts),
      );
      // `diffFile` answered the bare text until API 52. An external plugin
      // built before that reads `.length` off the answer, so it gets the text
      // alone. The shim lives here, not in the services gate: this bridge is
      // where the host meets a plugin compiled against an older contract —
      // a built-in is compiled against the current GitDiff — and the answer
      // leaves the typed world here anyway. The floor is the manifest's word
      // on which contract the plugin speaks.
      return ctx.manifest.minApiVersion < GIT_DIFF_ANSWER_API
        ? answer.then((diff) => diff.text)
        : answer;
    },
    // Git watches share the fs watches' plumbing: same guest-minted id space
    // (one counter mints both), same retained-Disposable map, same
    // `fswatch:<id>` push channel — a watch is a watch, only the backend
    // differs.
    "services.git.watch": ([id, repo]) => {
      const key = num(id, "git.watch id");
      watches.get(key)?.dispose();
      const handle = ctx.services.git.watch(str(repo, "git.watch repo"), () =>
        push(fswatchChannel(key), undefined),
      );
      watches.set(key, handle);
      // The call answers once the watch is armed, and fails when the host
      // refused it — the guest's handle promises the same on its `ready`.
      return handle.ready;
    },
    "services.git.unwatch": ([id]) => {
      const key = num(id, "git.unwatch id");
      watches.get(key)?.dispose();
      watches.delete(key);
    },
    "services.downloads.start": ([raw]) => {
      const request = decodeDownloadRequest(raw);
      const stream = ctx.services.downloads.start(request);
      activeDownloads.add(request.id);
      void (async () => {
        try {
          for await (const state of stream) {
            push(downloadChannel(request.id), state);
          }
        } catch (error) {
          const failed: DownloadState = {
            id: request.id,
            phase: "failed",
            received: 0,
            total: request.integrity?.bytes ?? null,
            error: errorMessage(error),
          };
          push(downloadChannel(request.id), failed);
        } finally {
          activeDownloads.delete(request.id);
        }
      })();
    },
    "services.downloads.cancel": ([id]) =>
      ctx.services.downloads.cancel(str(id, "downloads.cancel id")),
    "services.downloads.exists": ([target, integrity]) =>
      ctx.services.downloads.exists(
        decodeDownloadTarget(target),
        optional(integrity, isDownloadIntegrity, "downloads.exists integrity"),
      ),
    "services.downloads.remove": ([target]) =>
      ctx.services.downloads.remove(decodeDownloadTarget(target)),
    "services.speech.engines": () => ctx.services.speech.engines(),
    "services.speech.devices": () => ctx.services.speech.devices(),
    "services.speech.start": async ([id, options]) => {
      const key = num(id, "speech.start id");
      if (activeSpeechCaptures.has(key)) {
        throw new Error(`speech capture id already active: ${key}`);
      }
      // The whole reading crosses, not just the RMS: a realm plugin gets
      // the same peak/clipping/offset an in-process one does.
      // Only a string id crosses from the realm; anything else is "default".
      const deviceId = decodeSpeechDeviceId(options);
      const capture = await ctx.services.speech.startCapture(
        (_rms, level) => push(speechLevelChannel(key), level),
        deviceId === undefined ? {} : { deviceId },
      );
      // The realm may have been disposed while the device was opening — its
      // sweep already ran over a map this capture wasn't in yet. Storing it
      // now would park a live microphone where nothing can ever cancel it
      // (the built-in controller guards this same race; the RPC tier must
      // too, since the app holds ONE capture slot process-wide).
      if (isDisposed()) {
        void capture.cancel().catch(() => {});
        throw new Error("plugin bridge disposed");
      }
      activeSpeechCaptures.set(key, capture);
      return { device: capture.device, deviceMissing: capture.deviceMissing };
    },
    "services.speech.stop": ([id, opts]) => {
      const key = num(id, "speech.stop id");
      const capture = activeSpeechCaptures.get(key);
      if (!capture) throw new Error(`speech capture is not active: ${key}`);
      activeSpeechCaptures.delete(key);
      return capture.stop(decodeSpeechOptions(opts));
    },
    "services.speech.cancel": ([id]) => {
      const key = num(id, "speech.cancel id");
      const capture = activeSpeechCaptures.get(key);
      if (!capture) return;
      activeSpeechCaptures.delete(key);
      return capture.cancel();
    },
    "services.clipboard.writeText": ([text]) =>
      ctx.services.clipboard.writeText(str(text, "clipboard.writeText text")),
    "services.clipboard.readText": () => ctx.services.clipboard.readText(),
  };
}

function decodeSpeechDeviceId(options: unknown): string | undefined {
  if (!isObjectLike(options) || options.deviceId === undefined) return undefined;
  return str(options.deviceId, "speech.start deviceId");
}
