import type {
  DownloadRequest,
  DownloadState,
  DownloadTarget,
} from "@keepdeck/plugin-api";
import {
  cancelDownload,
  downloadExists,
  removeDownload,
  startDownload,
} from "../ipc/downloads";

const TERMINAL = new Set<DownloadState["phase"]>([
  "completed",
  "cancelled",
  "failed",
]);

export interface DownloadBackend {
  start(
    request: DownloadRequest,
    onState: (state: DownloadState) => void,
    constraints?: TransferConstraints,
  ): Promise<void>;
  cancel(id: string): Promise<void>;
  exists(target: DownloadTarget, integrity?: DownloadRequest["integrity"]): Promise<boolean>;
  remove(target: DownloadTarget): Promise<void>;
}

/** Host-only transfer constraints. They are not part of the plugin request. */
export interface TransferConstraints {
  allowedDomains?: readonly string[];
}

export interface DownloadLifecycle {
  onTerminal?: (state: DownloadState) => void;
}

interface Job {
  state: DownloadState;
  readers: Set<StateIterator>;
  terminal: boolean;
  onTerminal?: (state: DownloadState) => void;
}

class StateIterator implements AsyncIterator<DownloadState> {
  private value: DownloadState | null = null;
  private waiters: Array<(result: IteratorResult<DownloadState>) => void> = [];
  private closed = false;

  constructor(private readonly detach: () => void) {}

  push(state: DownloadState): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: state });
    // Progress is state, not an event log. A slow observer only needs the
    // newest snapshot, otherwise an unattended iterator grows without bound.
    else this.value = state;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
    this.detach();
  }

  next(): Promise<IteratorResult<DownloadState>> {
    const value = this.value;
    if (value) {
      this.value = null;
      return Promise.resolve({ done: false, value });
    }
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  return(): Promise<IteratorResult<DownloadState>> {
    this.close();
    this.value = null;
    return Promise.resolve({ done: true, value: undefined });
  }
}

/** App-scoped coordinator. Construction and lifetime belong to the composition root. */
export class DownloadManager {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly backend: DownloadBackend) {}

  start(
    request: DownloadRequest,
    constraints?: TransferConstraints,
    lifecycle?: DownloadLifecycle,
  ): AsyncIterable<DownloadState> {
    if (this.jobs.has(request.id)) {
      throw new Error(`download id already used: ${request.id}`);
    }
    const job: Job = {
      state: {
        id: request.id,
        phase: "queued",
        received: 0,
        total: request.integrity?.bytes ?? null,
      },
      readers: new Set(),
      terminal: false,
      onTerminal: lifecycle?.onTerminal,
    };
    this.jobs.set(request.id, job);
    const stream = this.view(job);
    let started: Promise<void>;
    try {
      started = this.backend.start(
        request,
        (state) => this.accept(job, state),
        constraints,
      );
    } catch (error) {
      this.accept(job, {
        ...job.state,
        phase: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return stream;
    }
    void started
      .then(() => {
        if (!job.terminal) {
          this.accept(job, {
            ...job.state,
            phase: "failed",
            error: "download backend stopped without a terminal state",
          });
        }
      })
      .catch((error: unknown) => {
        if (!job.terminal) {
          this.accept(job, {
            ...job.state,
            phase: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return stream;
  }

  cancel(id: string): Promise<void> {
    return this.backend.cancel(id);
  }

  exists(target: DownloadTarget, integrity?: DownloadRequest["integrity"]): Promise<boolean> {
    return this.backend.exists(target, integrity);
  }

  remove(target: DownloadTarget): Promise<void> {
    return this.backend.remove(target);
  }

  private accept(job: Job, state: DownloadState): void {
    if (job.terminal || state.id !== job.state.id) return;
    job.state = state;
    job.terminal = TERMINAL.has(state.phase);
    for (const reader of [...job.readers]) reader.push(state);
    if (job.terminal) {
      for (const reader of [...job.readers]) reader.close();
      this.jobs.delete(state.id);
      job.onTerminal?.(state);
      job.onTerminal = undefined;
    }
  }

  private view(job: Job): AsyncIterable<DownloadState> {
    return {
      [Symbol.asyncIterator]: () => {
        let iterator!: StateIterator;
        iterator = new StateIterator(() => job.readers.delete(iterator));
        iterator.push(job.state);
        if (job.terminal) iterator.close();
        else job.readers.add(iterator);
        return iterator;
      },
    };
  }
}

export const tauriDownloadBackend: DownloadBackend = {
  start: startDownload,
  cancel: cancelDownload,
  exists: downloadExists,
  remove: removeDownload,
};
