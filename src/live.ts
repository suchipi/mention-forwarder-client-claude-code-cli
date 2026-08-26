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
};

/**
 * Past this long without a publish, an entry is read as abandoned. A process
 * publishes a heartbeat well inside it, so this only catches one that was killed
 * outright, or whose pid has since been handed to something else.
 */
const STALE_MS = 120000;

export type LiveRegistry = {
  /** Writes this process's entry. Best effort: a failure costs the web view a row, never the run. */
  publish(snapshot: ConversationSnapshot): void;
  /** Drops this process's entry, on the way out. */
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
 * A directory of one JSON file per running conversation, named after its pid.
 *
 * mention-forwarder runs this program once per conversation, so no single process
 * can see the others; a file each is what makes a list of them possible without a
 * daemon in the middle. Each process writes only its own file, so there is
 * nothing to coordinate: the only shared operation is reading the directory.
 */
export function createLiveRegistry(dir: string, log: Logger): LiveRegistry {
  const startedAt = new Date().toISOString();
  const file = join(dir, `${process.pid}.json`);
  let complained = false;

  function warnOnce(message: string, error: unknown): void {
    if (complained) return;
    complained = true;
    log.warn(message, { dir, error: error instanceof Error ? error.message : String(error) });
  }

  return {
    publish(snapshot) {
      const entry: LiveConversation = {
        ...snapshot,
        pid: process.pid,
        startedAt,
        updatedAt: new Date().toISOString(),
      };
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
    },

    remove() {
      try {
        unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          warnOnce("could not remove this conversation from the web view", error);
        }
      }
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

      return entries.sort((one, other) => Date.parse(one.startedAt) - Date.parse(other.startedAt));
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
export function startPublishing(registry: LiveRegistry, snapshot: () => ConversationSnapshot): { stop(): void } {
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
