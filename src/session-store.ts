import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "./logger.ts";

/** What is remembered about one conversation between processes. */
export type Remembered = {
  /**
   * Absent until the session has started, because a `[model=...]` group can settle
   * a thread's settings before anything has run in it.
   */
  sessionId?: string;
  /** The directory the session was started in. Claude Code files a session under its project. */
  cwd: string;
  /** The thread's model and effort, as set by a `[model=...]` group. */
  model?: string;
  effort?: string;
  /**
   * Set once the thread has thrown its history away, which outlives the process
   * that did it: a cleared thread has no session for a later one to resume, and
   * this is what keeps that gap from being filled by the work it came out of.
   */
  cleared?: boolean;
};

type Entry = Remembered & { updatedAt: string };
type Contents = { version: 1; conversations: Record<string, Entry> };

export type SessionStore = {
  /** What is remembered for this conversation, if it was remembered for the same directory. */
  get(conversationKey: string): Remembered | undefined;
  set(conversationKey: string, remembered: Remembered): void;
  forget(conversationKey: string): void;
};

/**
 * Remembers which Claude Code session belongs to which conversation, so a thread
 * picks up its own history after the command exits: mention-forwarder starts one
 * process per conversation and ends it after `sessionIdleMs`, which is usually
 * long before the conversation itself is over.
 *
 * Pass `path: undefined` to keep nothing, in which case every process starts a
 * fresh session. Storage is best effort: a failure to read or write is logged and
 * costs history, never the run.
 */
export function createSessionStore(path: string | undefined, cwd: string, log: Logger): SessionStore {
  if (path === undefined) {
    return { get: () => undefined, set: () => {}, forget: () => {} };
  }
  const file = path;

  function read(): Contents {
    let raw: string;
    try {
      raw = readFileSync(file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") log.warn("could not read the session file", { path, error: (error as Error).message });
      return { version: 1, conversations: {} };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<Contents>;
      if (parsed.version !== 1 || parsed.conversations == null || typeof parsed.conversations !== "object") {
        log.warn("ignoring a session file this version does not understand", { path });
        return { version: 1, conversations: {} };
      }
      return { version: 1, conversations: parsed.conversations };
    } catch (error) {
      log.warn("ignoring an unreadable session file", { path, error: (error as Error).message });
      return { version: 1, conversations: {} };
    }
  }

  function write(contents: Contents): void {
    // Written aside and renamed into place: conversations run as separate
    // processes, and a reader must never catch a half-written file.
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify(contents, null, 2)}\n`);
      renameSync(temporary, file);
    } catch (error) {
      log.warn("could not save the session file", { path, error: (error as Error).message });
      try {
        unlinkSync(temporary);
      } catch {
        // Nothing to clean up when the write itself never happened.
      }
    }
  }

  function update(change: (conversations: Record<string, Entry>) => void): void {
    const contents = read();
    change(contents.conversations);
    write(contents);
  }

  return {
    get(conversationKey) {
      const entry = read().conversations[conversationKey];
      if (entry === undefined) return undefined;
      if (entry.cwd !== cwd) {
        log.info("ignoring a session remembered for another directory", { remembered: entry.cwd, now: cwd });
        return undefined;
      }
      return {
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        model: entry.model,
        effort: entry.effort,
        cleared: entry.cleared,
      };
    },

    set(conversationKey, remembered) {
      update((conversations) => {
        conversations[conversationKey] = { ...remembered, updatedAt: new Date().toISOString() };
      });
    },

    forget(conversationKey) {
      update((conversations) => {
        delete conversations[conversationKey];
      });
    },
  };
}
