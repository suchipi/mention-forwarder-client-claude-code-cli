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

/** The bare words a group may carry to give it one that starts on nothing rather than on a copy. */
export const NEW_WORDS: ReadonlySet<string> = new Set(["new"]);

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
  /** And another, and the only kind about a thread other than the one it was written in. */
  fork?: boolean;
  /** The same, on a session that starts knowing nothing rather than on a copy of the one above. */
  new?: boolean;
};

export type Parsed = {
  /** What the group asked for, carrying no settings when the mention did not carry one. */
  directive: Directive;
  /** The mention with the group removed. */
  rest: string;
  /** Set when the group was addressed to this program but could not be honoured. */
  problem?: string;
};

const GROUP = /\[([^\]\n]*)\]/g;
const SLASH = /^\/([a-z]+)$/i;
const CODE = /(`+)[\s\S]*?\1/g;

function inCode(text: string, at: number): boolean {
  for (const span of text.matchAll(CODE)) {
    const start = span.index ?? 0;
    if (start <= at && at < start + span[0].length) return true;
  }
  return false;
}

function nothing(rest: string, problem?: string): Parsed {
  return problem === undefined
    ? { directive: { settings: {} }, rest }
    : { directive: { settings: {} }, rest, problem };
}

/** A group cut out from between two words would otherwise leave the gap behind. */
function withoutGroup(text: string, at: number, length: number): string {
  const before = text.slice(0, at).replace(/[^\S\n]+$/, "");
  const after = text.slice(at + length).replace(/^[^\S\n]+/, "");
  const joint = before === "" || after === "" || before.endsWith("\n") || after.startsWith("\n") ? "" : " ";
  return (before + joint + after).trim();
}

/**
 * Reads a `[setting=..., interrupt, exit, clear, compact, fork, new]` group out of a mention.
 *
 * The group is read wherever in the mention it was written, because people write
 * one where it reads best — after a sentence of their own, or after the trigger
 * phrase — and a group that went unread takes the thread somewhere nobody asked
 * for. Where a mention carries more than one, the first this understands is the
 * one read, and the rest reach the agent as written.
 *
 * A message that is nothing but `/clear` or `/compact` is read as the group of
 * the same name, because those are the words Claude Code itself takes for the
 * two, and somebody who types one into a thread means it. Nothing follows one:
 * a line with anything else on it is a person's words about the command rather
 * than the command.
 *
 * A setting is named as the config file names it, and every setting in that file
 * can be written here, so a thread can be put on anything the process was started
 * on. Names are matched without regard to case; which values a setting takes is
 * the setting's own business.
 *
 * Anything else in brackets is left alone and passed to the agent as written,
 * because a comment may well carry `[WIP]` or `[bug]` and mean nothing by it. The
 * text of a markdown link is left alone for the same reason, and so is anything in
 * backticks, since a thread about this program is full of people naming a group
 * rather than writing one. A group that names a setting this understands but
 * cannot honour is reported instead, so a typo is never silently ignored.
 */
export function parseDirective(body: string): Parsed {
  const text = body.trim();
  const slash = SLASH.exec(text);
  if (slash !== null) {
    const word = (slash[1] ?? "").toLowerCase();
    if (CLEAR_WORDS.has(word)) return { directive: { settings: {}, clear: true }, rest: "" };
    if (COMPACT_WORDS.has(word)) return { directive: { settings: {}, compact: true }, rest: "" };
    return nothing(text);
  }

  for (const match of text.matchAll(GROUP)) {
    const at = match.index ?? 0;
    // `[new](https://…)` is a link, and `` `[stop]` `` is somebody talking about one.
    if (text[at + match[0].length] === "(" || inCode(text, at)) continue;
    const read = readGroup(text, at, match[0], match[1] ?? "");
    if (read !== undefined) return read;
  }
  return nothing(text);
}

/**
 * Reads one group, handing back nothing where those brackets turn out to be
 * somebody else's rather than a group written to this program.
 */
function readGroup(text: string, at: number, whole: string, inside: string): Parsed | undefined {
  const parts = inside
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) return undefined;

  const rest = withoutGroup(text, at, whole.length);
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
      else if (NEW_WORDS.has(word)) directive.new = true;
      else return undefined;
      continue;
    }
    // A name this program has no setting for is somebody else's brackets rather
    // than a mistake: a comment may open with `[fixes=#12]` and mean only that.
    const key = settingNamed(part.slice(0, split).trim());
    if (key === undefined) return undefined;
    const problem = readSetting(
      directive.settings,
      key,
      part.slice(split + 1).trim(),
    );
    if (problem !== undefined) return nothing(rest, problem);
  }

  if (directive.fork === true && directive.new === true) {
    return nothing(
      rest,
      "That group asks me to give this review thread a session of its own twice over. `[fork]` opens one on a copy of the pull request's, `[new]` opens one that starts knowing nothing, so pick one.",
    );
  }
  if (
    (directive.fork === true || directive.new === true) &&
    (directive.interrupt === true ||
      directive.exit === true ||
      directive.clear === true ||
      directive.compact === true)
  ) {
    return nothing(
      rest,
      "That group asks me to give this review thread a session of its own and to act on the thread it was written in at the same time. `[fork]` and `[new]` start a thread of its own, where stopping, exiting, clearing and compacting are all about the one this comment is already in, so write one and then the other.",
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
