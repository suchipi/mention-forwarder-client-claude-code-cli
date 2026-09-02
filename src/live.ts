import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ConversationSnapshot } from "./conversation.ts";
import type { Logger } from "./logger.ts";

/** One conversation process as the web view sees it: its own snapshot, plus who published it. */
export type LiveConversation = ConversationSnapshot & {
  pid: number;
  /** When this process started. */
  startedAt: string;
  /** When it last published, which is how a process killed without cleanup is spotted. */
  updatedAt: string;
  /**
   * Where this conversation comes among the ones that process is running, so a
   * review thread is listed under the thread it was split off rather than
   * wherever its file name happens to sort. Absent from entries written before
   * a process could run more than one.
   */
  index?: number;
};

/**
 * Past this long without a publish, an entry is read as abandoned. A process
 * publishes a heartbeat well inside it, so this only catches one that was killed
 * outright, or whose pid has since been handed to something else.
 */
const STALE_MS = 120000;

export type LiveRegistry = {
  /** Writes an entry for each conversation this process is running. Best effort: a failure costs the web view a row, never the run. */
  publish(snapshots: ConversationSnapshot[]): void;
  /** Drops every entry this process wrote, on the way out. */
  remove(): void;
  /** Every entry a live process wrote, oldest process first. */
  list(): LiveConversation[];
};

/** How often the snapshot is checked for a change worth publishing. */
const POLL_MS = 1000;

/** How often an unchanged entry is published anyway, to stay well inside `STALE_MS`. */
const HEARTBEAT_MS = 30000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means somebody else's process holds the pid, which is still not ours.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A directory of one JSON file per running conversation, named after the process
 * running it.
 *
 * mention-forwarder runs this program once per conversation, so no single process
 * can see the others; a file each is what makes a list of them possible without a
 * daemon in the middle. Each process writes only its own files, so there is
 * nothing to coordinate: the only shared operation is reading the directory.
 *
 * A process can be running more than one conversation — a review thread that has
 * [forked](../README.md#forking-a-review-thread) is answered beside the pull
 * request it came out of — and each of those is a row of its own, so the first
 * takes the pid and the rest are numbered after it.
 */
export function createLiveRegistry(dir: string, log: Logger): LiveRegistry {
  const startedAt = new Date().toISOString();
  const fileFor = (index: number) => join(dir, index === 0 ? `${process.pid}.json` : `${process.pid}.${index}.json`);
  /** How many files this process has written, so one it no longer publishes is taken away rather than left to go stale. */
  let written = 0;
  let complained = false;

  function warnOnce(message: string, error: unknown): void {
    if (complained) return;
    complained = true;
    log.warn(message, { dir, error: error instanceof Error ? error.message : String(error) });
  }

  function drop(path: string): void {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        warnOnce("could not remove this conversation from the web view", error);
      }
    }
  }

  return {
    publish(snapshots) {
      const now = new Date().toISOString();
      snapshots.forEach((snapshot, index) => {
        const entry: LiveConversation = { ...snapshot, pid: process.pid, startedAt, updatedAt: now, index };
        const file = fileFor(index);
        // Written aside and renamed into place: whichever process serves the web
        // view reads these files, and must never catch a half-written one.
        const temporary = `${file}.tmp`;
        try {
          mkdirSync(dir, { recursive: true });
          writeFileSync(temporary, `${JSON.stringify(entry, null, 2)}\n`);
          renameSync(temporary, file);
        } catch (error) {
          warnOnce("could not publish this conversation for the web view", error);
          try {
            unlinkSync(temporary);
          } catch {
            // Nothing to clean up when the write itself never happened.
          }
        }
      });
      for (let index = snapshots.length; index < written; index += 1) drop(fileFor(index));
      written = snapshots.length;
    },

    remove() {
      for (let index = 0; index < Math.max(written, 1); index += 1) drop(fileFor(index));
      written = 0;
    },

    list() {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          warnOnce("could not read the live conversation directory", error);
        }
        return [];
      }

      const entries: LiveConversation[] = [];
      const now = Date.now();

      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const path = join(dir, name);

        let entry: LiveConversation;
        try {
          entry = JSON.parse(readFileSync(path, "utf8")) as LiveConversation;
        } catch {
          // A file being renamed into place right now, or one this version cannot
          // read. Either way the next poll will have it.
          continue;
        }
        if (typeof entry.pid !== "number") continue;

        const gone = !alive(entry.pid) || now - Date.parse(entry.updatedAt) > STALE_MS;
        if (gone) {
          try {
            unlinkSync(path);
          } catch {
            // Another process reading the directory got there first.
          }
          continue;
        }
        entries.push(entry);
      }

      return entries.sort(
        (one, other) =>
          Date.parse(one.startedAt) - Date.parse(other.startedAt) || (one.index ?? 0) - (other.index ?? 0),
      );
    },
  };
}

/**
 * Keeps this process's entry current by polling the conversation for its
 * snapshot, rather than by having the state machine report every change: the
 * state machine decides things, and a view of it should not be one of them.
 *
 * A write only happens when something actually changed, or when the last one is
 * old enough that a reader could start calling it stale.
 */
export function startPublishing(registry: LiveRegistry, snapshot: () => ConversationSnapshot[]): { stop(): void } {
  let published = "";
  let publishedAt = 0;

  const tick = () => {
    const now = snapshot();
    const serialized = JSON.stringify(now);
    if (serialized === published && Date.now() - publishedAt < HEARTBEAT_MS) return;
    published = serialized;
    publishedAt = Date.now();
    registry.publish(now);
  };

  tick();
  const timer = setInterval(tick, POLL_MS);
  // A view of the process must never be the reason the process is still here.
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
