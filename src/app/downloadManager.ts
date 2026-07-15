import type {
  DownloadRequest,
  DownloadState,
  DownloadTarget,
  LegacyDownloadRequest,
} from "@keepdeck/plugin-api";
import {
  adoptLegacyDownload,
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
const TERMINAL_JOBS_LIMIT = 128;
const RECENT_IDS_LIMIT = 4096;

export interface DownloadBackend {
  start(
    request: DownloadRequest,
    onState: (state: DownloadState) => void,
    policy?: DownloadPolicy,
  ): Promise<void>;
  cancel(id: string): Promise<void>;
  exists(target: DownloadTarget): Promise<boolean>;
  remove(target: DownloadTarget): Promise<void>;
  adoptLegacy(request: LegacyDownloadRequest): Promise<void>;
}

/** Host-only transfer constraints. They are not part of the plugin request. */
export interface DownloadPolicy {
  allowedDomains?: readonly string[];
  /** Internal lifecycle hook for capability ownership bookkeeping. */
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
  private readonly recentIds = new Set<string>();
  private readonly recentOrder: string[] = [];
  private readonly terminalOrder: string[] = [];

  constructor(private readonly backend: DownloadBackend) {}

  start(
    request: DownloadRequest,
    policy?: DownloadPolicy,
  ): AsyncIterable<DownloadState> {
    if (this.jobs.has(request.id) || this.recentIds.has(request.id)) {
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
      onTerminal: policy?.onTerminal,
    };
    this.jobs.set(request.id, job);
    const stream = this.view(job);
    let started: Promise<void>;
    try {
      started = this.backend.start(
        request,
        (state) => this.accept(job, state),
        policy,
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

  observe(id: string): AsyncIterable<DownloadState> | null {
    const job = this.jobs.get(id);
    return job ? this.view(job) : null;
  }

  cancel(id: string): Promise<void> {
    const job = this.jobs.get(id);
    // Cancellation commonly races the terminal state delivered by the
    // backend. Once an id is known, that race is intentionally idempotent.
    if (job?.terminal || this.recentIds.has(id)) return Promise.resolve();
    if (!job) return Promise.reject(new Error(`download is not active: ${id}`));
    return this.backend.cancel(id);
  }

  exists(target: DownloadTarget): Promise<boolean> {
    return this.backend.exists(target);
  }

  remove(target: DownloadTarget): Promise<void> {
    return this.backend.remove(target);
  }

  adoptLegacy(request: LegacyDownloadRequest): Promise<void> {
    return this.backend.adoptLegacy(request);
  }

  private accept(job: Job, state: DownloadState): void {
    if (job.terminal || state.id !== job.state.id) return;
    job.state = state;
    job.terminal = TERMINAL.has(state.phase);
    for (const reader of [...job.readers]) reader.push(state);
    if (job.terminal) {
      for (const reader of [...job.readers]) reader.close();
      this.retainTerminal(state.id);
      job.onTerminal?.(state);
      job.onTerminal = undefined;
    }
  }

  private retainTerminal(id: string): void {
    if (!this.recentIds.has(id)) {
      this.recentIds.add(id);
      this.recentOrder.push(id);
    }
    this.terminalOrder.push(id);
    while (this.terminalOrder.length > TERMINAL_JOBS_LIMIT) {
      const expired = this.terminalOrder.shift();
      if (expired) this.jobs.delete(expired);
    }
    while (this.recentOrder.length > RECENT_IDS_LIMIT) {
      const expired = this.recentOrder.shift();
      if (expired) this.recentIds.delete(expired);
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
  adoptLegacy: adoptLegacyDownload,
};
