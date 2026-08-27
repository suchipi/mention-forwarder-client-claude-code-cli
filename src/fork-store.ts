import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "./logger.ts";

/** One line of the fork file: something a session made, and the conversation that made it. */
export type ForkRequest = {
  /** Permalink to what was made, e.g. a pull request. A mention at or under it forks `from`'s session. */
  url: string;
  /** The `conversationKey` of the thread whose session recorded this. */
  from: string;
};

export type ForkStore = {
  /** The file agents are told to append to, or undefined when nothing is kept. */
  readonly path: string | undefined;
  /** The directory that file is in, which the agent is given so writing there is not a permission request. */
  readonly directory: string | undefined;
  /** The last thread to claim this url as its own work, if one did. */
  parentOf(url: string): ForkRequest | undefined;
};

const OFF: ForkStore = {
  path: undefined,
  directory: undefined,
  parentOf: () => undefined,
};

/**
 * A mention's url points at one comment inside a thread, and a recorded url at
 * the thread itself, so the fragment and the query go before the two are
 * compared. Case goes with them: a url an agent wrote down and the same url from
 * a webhook can differ in it.
 */
function normalize(url: string): string {
  const [beforeFragment = ""] = url.split("#");
  const [bare = ""] = beforeFragment.split("?");
  return bare.replace(/\/+$/, "").toLowerCase();
}

/** Whether `arrived` is the thread `recorded` names, or something inside it. */
function covers(recorded: string, arrived: string): boolean {
  const thread = normalize(recorded);
  const mention = normalize(arrived);
  if (thread === "" || mention === "") return false;
  return mention === thread || mention.startsWith(`${thread}/`);
}

function toRequest(line: string): ForkRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const url = record["url"];
  const from = record["from"];
  if (typeof url !== "string" || url === "") return undefined;
  if (typeof from !== "string" || from === "") return undefined;
  return { url, from };
}

/**
 * Remembers which thread a piece of work came out of, so the thread it opens
 * carries on from it rather than starting knowing nothing.
 *
 * The agent writes here itself: its system prompt tells it to append a line
 * naming the pull request it just opened, because it is the only thing that
 * knows a pull request was opened at all. Mentions arriving on that pull request
 * are a conversation of their own, with a session of their own, and this is what
 * lets that session start as a fork of the one that did the work.
 *
 * Append-only, one JSON object per line, so processes writing at the same moment
 * cannot lose each other's lines the way a rewritten file would. Nothing here
 * writes: a line is a claim by whoever wrote it, and the newest matching one
 * wins. Reading is best effort, and a file that is not there is a thread that
 * opened nothing.
 */
export function createForkStore(path: string | undefined, log: Logger): ForkStore {
  if (path === undefined) return OFF;
  const file = path;

  const directory = dirname(file);
  try {
    // Made up front because the directory is handed to claude as one the agent
    // may write in, and a directory that is not there is refused at startup.
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    log.warn("could not record forks; the directory for them could not be made", { directory, error: (error as Error).message });
    return OFF;
  }

  function read(): string[] {
    try {
      return readFileSync(file, "utf8").split("\n");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") log.warn("could not read the fork file", { path: file, error: (error as Error).message });
      return [];
    }
  }

  return {
    path: file,
    directory,

    parentOf(url) {
      const lines = read();
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]?.trim() ?? "";
        if (line === "") continue;
        const request = toRequest(line);
        if (request === undefined) {
          log.warn("ignoring a line in the fork file that is not a fork request", { path: file, line: line.slice(0, 200) });
          continue;
        }
        if (covers(request.url, url)) return request;
      }
      return undefined;
    },
  };
}
