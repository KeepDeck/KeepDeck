import type {
  Disposable,
  DownloadRequest,
  DownloadState,
  DownloadTarget,
  FsReadFileOptions,
  GitDiffOptions,
  GitHistoryOptions,
  PluginContext,
  PluginSpawnOptions,
  SpeechCapture,
  SpeechCaptureOptions,
} from "@keepdeck/plugin-api";
import { downloadChannel, fswatchChannel, speechLevelChannel } from "./protocol";
import type { HostSessions } from "./hostSessions";

/**
 * The `services.*` half of the dispatch table: thin adaptors from a positional
 * `args` array onto one member of the real `ctx.services`. They are all the
 * same shape and share the same three concerns — cast the wire's arguments,
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
      ctx.services.exec.runOnce(
        request as import("@keepdeck/plugin-api").PluginExecRequest,
      ),
    "services.ports.allocate": ([key]) => ctx.services.ports.allocate(key as string),
    "services.opener.openUrl": ([url]) => ctx.services.opener.openUrl(url as string),
    "services.opener.openPath": ([path]) =>
      ctx.services.opener.openPath(path as string),
    "services.opener.openPathWith": ([path, application]) =>
      ctx.services.opener.openPathWith(path as string, application as string),
    "services.sessions.spawn": ([opts]) =>
      sessions.spawn(opts as PluginSpawnOptions),
    "services.sessions.write": ([id, data]) =>
      sessions.write(id as string, data as string),
    "services.sessions.resize": ([id, cols, rows]) =>
      sessions.resize(id as string, cols as number, rows as number),
    "services.sessions.close": ([id]) => sessions.close(id as string),
    "services.fs.readDir": ([path]) => ctx.services.fs.readDir(path as string),
    "services.fs.readFile": ([path, opts]) =>
      ctx.services.fs.readFile(
        path as string,
        opts as FsReadFileOptions | undefined,
      ),
    // A watch is a subscription: the guest mints the id, the host holds the
    // Disposable under it and pushes `fswatch:<id>` on each change.
    "services.fs.watch": ([id, path]) => {
      const key = id as number;
      watches.get(key)?.dispose();
      watches.set(
        key,
        ctx.services.fs.watch(path as string, () =>
          push(fswatchChannel(key), undefined),
        ),
      );
    },
    "services.sqlite.query": ([dbPath, sql, params]) =>
      ctx.services.sqlite.query(
        dbPath as string,
        sql as string,
        params as string[] | undefined,
      ),
    "services.fsWrite.mkdir": ([path]) =>
      ctx.services.fsWrite.mkdir(path as string),
    "services.fsWrite.copyFile": ([src, dst]) =>
      ctx.services.fsWrite.copyFile(src as string, dst as string),
    "services.fsWrite.writeFile": ([path, text]) =>
      ctx.services.fsWrite.writeFile(path as string, text as string),
    "services.fsWrite.appendLine": ([path, line]) =>
      ctx.services.fsWrite.appendLine(path as string, line as string),
    "services.fs.unwatch": ([id]) => {
      const key = id as number;
      watches.get(key)?.dispose();
      watches.delete(key);
    },
    "services.git.status": ([repo]) => ctx.services.git.status(repo as string),
    "services.git.history": ([repo, opts]) =>
      ctx.services.git.history(
        repo as string,
        opts as GitHistoryOptions | undefined,
      ),
    "services.git.branches": ([repo]) =>
      ctx.services.git.branches(repo as string),
    "services.git.changedFiles": ([repo, from, to]) =>
      ctx.services.git.changedFiles(
        repo as string,
        from as string,
        to as string | undefined,
      ),
    "services.git.diffFile": ([repo, file, opts]) =>
      ctx.services.git.diffFile(
        repo as string,
        file as string,
        opts as GitDiffOptions | undefined,
      ),
    // Git watches share the fs watches' plumbing: same guest-minted id space
    // (one counter mints both), same retained-Disposable map, same
    // `fswatch:<id>` push channel — a watch is a watch, only the backend
    // differs.
    "services.git.watch": ([id, repo]) => {
      const key = id as number;
      watches.get(key)?.dispose();
      watches.set(
        key,
        ctx.services.git.watch(repo as string, () =>
          push(fswatchChannel(key), undefined),
        ),
      );
    },
    "services.git.unwatch": ([id]) => {
      const key = id as number;
      watches.get(key)?.dispose();
      watches.delete(key);
    },
    "services.downloads.start": ([raw]) => {
      const request = raw as DownloadRequest;
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
            error: error instanceof Error ? error.message : String(error),
          };
          push(downloadChannel(request.id), failed);
        } finally {
          activeDownloads.delete(request.id);
        }
      })();
    },
    "services.downloads.cancel": ([id]) =>
      ctx.services.downloads.cancel(id as string),
    "services.downloads.exists": ([target, integrity]) =>
      ctx.services.downloads.exists(
        target as DownloadTarget,
        integrity as DownloadRequest["integrity"],
      ),
    "services.downloads.remove": ([target]) =>
      ctx.services.downloads.remove(target as DownloadTarget),
    "services.speech.engines": () => ctx.services.speech.engines(),
    "services.speech.start": async ([id]) => {
      const key = id as number;
      if (activeSpeechCaptures.has(key)) {
        throw new Error(`speech capture id already active: ${key}`);
      }
      const capture = await ctx.services.speech.startCapture((level) =>
        push(speechLevelChannel(key), level),
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
    },
    "services.speech.stop": ([id, opts]) => {
      const key = id as number;
      const capture = activeSpeechCaptures.get(key);
      if (!capture) throw new Error(`speech capture is not active: ${key}`);
      activeSpeechCaptures.delete(key);
      return capture.stop(opts as SpeechCaptureOptions);
    },
    "services.speech.cancel": ([id]) => {
      const key = id as number;
      const capture = activeSpeechCaptures.get(key);
      if (!capture) return;
      activeSpeechCaptures.delete(key);
      return capture.cancel();
    },
    "services.clipboard.writeText": ([text]) =>
      ctx.services.clipboard.writeText(text as string),
    "services.clipboard.readText": () => ctx.services.clipboard.readText(),
  };
}
