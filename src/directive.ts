import { readSetting, settingNamed, type ThreadSettings } from "./settings.ts";

/** The bare words a group may carry to call the thread's running turn off. */
export const INTERRUPT_WORDS: ReadonlySet<string> = new Set([
  "interrupt",
  "stop",
  "int",
]);

/** The bare words a group may carry to end the thread's `claude` process. */
export const EXIT_WORDS: ReadonlySet<string> = new Set(["exit", "quit"]);

/** The bare words a group may carry to throw the thread's history away. */
export const CLEAR_WORDS: ReadonlySet<string> = new Set(["clear"]);

/** The bare words a group may carry to have that history summarized in place instead. */
export const COMPACT_WORDS: ReadonlySet<string> = new Set(["compact"]);

/** The bare words a group may carry to give the GitHub review thread it was written in a session of its own. */
export const FORK_WORDS: ReadonlySet<string> = new Set(["fork"]);

export type Directive = {
  /** The settings the group asked this thread to take on, named as the config file names them. */
  settings: ThreadSettings;
  /** Unlike the settings this is something to do, not something to keep. */
  interrupt?: boolean;
  /** Something to do as well: end the process, and not only the turn. */
  exit?: boolean;
  /** And another: throw the thread's history away, so the next turn opens a session of its own. */
  clear?: boolean;
  /** And another: keep that history as a summary of itself rather than throwing it away. */
  compact?: boolean;
  /** And another, and the only one about a thread other than the one it was written in. */
  fork?: boolean;
};

export type Parsed = {
  /** What the group asked for, carrying no settings when the mention did not open with one. */
  directive: Directive;
  /** The mention with the group removed. */
  rest: string;
  /** Set when the group was addressed to this program but could not be honoured. */
  problem?: string;
};

const GROUP = /^\[([^\]\n]*)\]/;

function nothing(rest: string, problem?: string): Parsed {
  return problem === undefined
    ? { directive: { settings: {} }, rest }
    : { directive: { settings: {} }, rest, problem };
}

/**
 * Reads a `[setting=..., interrupt, exit, clear, compact, fork]` group off the front of a mention.
 *
 * A setting is named as the config file names it, and every setting in that file
 * can be written here, so a thread can be put on anything the process was started
 * on. Names are matched without regard to case; which values a setting takes is
 * the setting's own business.
 *
 * Anything else in brackets is left alone and passed to the agent as written,
 * because a comment may well open with `[WIP]` or `[bug]` and mean nothing by it.
 * A group that names a setting this understands but cannot honour is reported
 * instead, so a typo is never silently ignored.
 */
export function parseDirective(body: string): Parsed {
  const text = body.trim();
  const match = GROUP.exec(text);
  if (match === null) return nothing(text);

  const inside = match[1] ?? "";
  const parts = inside
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) return nothing(text);

  const rest = text.slice(match[0].length).trim();
  const directive: Directive = { settings: {} };
  for (const part of parts) {
    const split = part.indexOf("=");
    if (split < 0) {
      const word = part.toLowerCase();
      if (INTERRUPT_WORDS.has(word)) directive.interrupt = true;
      else if (EXIT_WORDS.has(word)) directive.exit = true;
      else if (CLEAR_WORDS.has(word)) directive.clear = true;
      else if (COMPACT_WORDS.has(word)) directive.compact = true;
      else if (FORK_WORDS.has(word)) directive.fork = true;
      else return nothing(text);
      continue;
    }
    // A name this program has no setting for is somebody else's brackets rather
    // than a mistake: a comment may open with `[fixes=#12]` and mean only that.
    const key = settingNamed(part.slice(0, split).trim());
    if (key === undefined) return nothing(text);
    const problem = readSetting(
      directive.settings,
      key,
      part.slice(split + 1).trim(),
    );
    if (problem !== undefined) return nothing(rest, problem);
  }

  if (
    directive.fork === true &&
    (directive.interrupt === true ||
      directive.exit === true ||
      directive.clear === true ||
      directive.compact === true)
  ) {
    return nothing(
      rest,
      "That group asks me to fork this review thread and to act on the thread it was written in at the same time. Forking starts a thread of its own, where stopping, exiting, clearing and compacting are all about the one this comment is already in, so write one and then the other.",
    );
  }
  if (directive.clear === true && directive.compact === true) {
    return nothing(
      rest,
      "That group asks me to clear and to compact at once. Clearing throws this thread's history away and compacting keeps a summary of it, so pick one.",
    );
  }

  return { directive, rest };
}
