import { vi } from "vitest";
import type { BrowserSharedSeam } from "./useSessionsBrowser";

/** The shared seam's stand-in: fixed revision/scanning, a keyed table the
 * tests may pre-fill, and recording declares. */
export const sharedOf = (over: Partial<BrowserSharedSeam> = {}): BrowserSharedSeam => ({
  scanning: false,
  revision: 1,
  enrichment: {
    entries: new Map(),
    pending: false,
    declare: vi.fn(),
  },
  ensureFresh: vi.fn(),
  transcript: vi.fn(() => Promise.resolve({ entries: [] })),
  ...over,
});
