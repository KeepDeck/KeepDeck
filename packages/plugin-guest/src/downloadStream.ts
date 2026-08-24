import type { DownloadState } from "@keepdeck/plugin-api";

/**
 * A download's progress, guest-side. The host pushes states on a channel; the
 * plugin consumes them with `for await`. Neither end knows about the other
 * here — this is pure fan-out with a memory, and it is written apart from the
 * context because it closes over nothing the bridge owns.
 *
 * Two rules carry the weight. LATEST-STATE MEMORY: a reader that starts late
 * gets the last state at once rather than waiting for a change that may never
 * come — a completed download must not read as a hung one. TERMINAL IS FINAL:
 * once completed, cancelled or failed, every reader is closed and the stream
 * detaches itself, so nothing keeps a finished transfer alive.
 */
class RemoteDownloadIterator implements AsyncIterator<DownloadState> {
  private value: DownloadState | null = null;
  private readonly waiters: Array<(result: IteratorResult<DownloadState>) => void> = [];
  private closed = false;

  constructor(private readonly detach: () => void) {}

  push(state: DownloadState): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: state });
    else this.value = state;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.waiters.splice(0)) {
      pending({ done: true, value: undefined });
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
    this.value = null;
    this.close();
    return Promise.resolve({ done: true, value: undefined });
  }
}

export class RemoteDownloadStream implements AsyncIterable<DownloadState> {
  private state: DownloadState | null = null;
  private terminal = false;
  private readonly readers = new Set<RemoteDownloadIterator>();

  constructor(private readonly detach: () => void) {}

  [Symbol.asyncIterator](): AsyncIterator<DownloadState> {
    let reader!: RemoteDownloadIterator;
    reader = new RemoteDownloadIterator(() => this.readers.delete(reader));
    if (this.state) reader.push(this.state);
    if (this.terminal) reader.close();
    else this.readers.add(reader);
    return reader;
  }

  push(state: DownloadState): void {
    if (this.terminal) return;
    this.state = state;
    for (const reader of [...this.readers]) reader.push(state);
    if (
      state.phase === "completed" ||
      state.phase === "cancelled" ||
      state.phase === "failed"
    ) {
      this.terminal = true;
      for (const reader of [...this.readers]) reader.close();
      this.detach();
    }
  }
}
