import { vi } from "vitest";
import type { LaunchOwner } from "../ipc/generated/lifecycle/LaunchOwner";
import type { PermitId } from "../ipc/generated/lifecycle/PermitId";
import type { Session, SessionEvent, SpawnOptions } from "../ipc/session";
import type { OpenSession } from "./ptyManager";

/** One process a registry asked the door for: what it asked, the channel its
 * events come back on, and the spawn's answer, still to be given. */
export interface Spawn {
  opts: SpawnOptions;
  permit: PermitId;
  owner: LaunchOwner;
  onEvent(event: SessionEvent): void;
  resolve(session: Session): void;
  reject(error: unknown): void;
}

/** A session as the door hands it over: every call recorded. */
export interface DoorSession extends Session {
  write: ReturnType<typeof vi.fn<Session["write"]>>;
  resize: ReturnType<typeof vi.fn<Session["resize"]>>;
  stop: ReturnType<typeof vi.fn<Session["stop"]>>;
}

/**
 * The door to the sessions machine, for a test running the REAL registry:
 * the one thing a registry needs from outside the page, and the only thing a
 * test stands in for. Each spawn is recorded with its event channel and a
 * pending answer, so a test drives the spawn's result, output and exit as the
 * sessions machine would.
 */
export function createSessionDoor() {
  const spawns: Spawn[] = [];
  let made = 0;
  const open: OpenSession = (opts, permit, owner, onEvent) =>
    new Promise((resolve, reject) => {
      spawns.push({ opts, permit, owner, onEvent, resolve, reject });
    });
  return {
    open,
    spawns,
    /** A session the door could answer a spawn with. */
    makeSession(): DoorSession {
      made += 1;
      return {
        id: made,
        write: vi.fn<Session["write"]>(() => Promise.resolve()),
        resize: vi.fn<Session["resize"]>(() => Promise.resolve()),
        stop: vi.fn<Session["stop"]>(() => Promise.resolve("exited")),
      };
    },
  };
}

export type SessionDoor = ReturnType<typeof createSessionDoor>;

/** The exit event of a process that ended with `code`. */
export function exitEvent(code: number | null): SessionEvent {
  return { type: "exit", success: code === 0, code };
}
