import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * How much of one block is kept. Long enough for a file a tool read, and short of
 * the tool results that make a long session's transcript tens of megabytes.
 */
const MAX_BODY_CHARS = 20000;

/** One thing that happened in a session, as the transcript view shows it. */
export type Moment = {
  /** When it happened, or "" for a line that carried no time of its own. */
  at: string;
  /** Who it came from: the thread, the agent, a tool call, what came back, or the CLI itself. */
  from: "person" | "agent" | "thought" | "tool" | "result" | "note";
  /** The tool's name, on a call. A result carries only `useId`, because it is not told the name. */
  tool?: string;
  /** What ties a call to what came back, which is the only thing that does when calls run in parallel. */
  useId?: string;
  text: string;
  /** Characters cut off the end of `text`. Absent when nothing was. */
  cut?: number;
  /** Set on anything a subagent did, which happens off to the side of the thread. */
  aside?: boolean;
  /** Set on a result the tool reported as a failure. */
  failed?: boolean;
};

export type Page = {
  /** Where reading actually started, which is not what was asked for when the file has been replaced. */
  from: number;
  /** Where to ask from next: the end of the last whole line read. */
  next: number;
  /** What the file measured when it was read. */
  size: number;
  moments: Moment[];
};

// --- reading values out of a transcript line without ever throwing on an unexpected shape ---

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Where Claude Code files its sessions: one directory per project, one file per session. */
export function projectsDirectory(): string {
  const configured = process.env["CLAUDE_CONFIG_DIR"];
  const base = configured === undefined || configured === "" ? join(homedir(), ".claude") : configured;
  return join(base, "projects");
}

/**
 * The file a session's transcript is in.
 *
 * Found by looking for the id under every project rather than by deriving the
 * project's directory name from the working directory: how a path turns into that
 * name is Claude Code's business and has no promise attached to it, while a
 * session id is unique by itself. One `stat` per project is cheaper than guessing.
 *
 * The id is checked before it is ever joined to a path, because it decides which
 * file is read and a request is where it comes from.
 */
export function findTranscript(sessionId: string, projects: string = projectsDirectory()): string | undefined {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId)) return undefined;

  let projectNames: string[];
  try {
    projectNames = readdirSync(projects);
  } catch {
    return undefined;
  }

  for (const project of projectNames) {
    const path = join(projects, project, `${sessionId}.jsonl`);
    try {
      if (statSync(path).isFile()) return path;
    } catch {
      // Not this project's session. The next one may have it.
    }
  }
  return undefined;
}

function body(value: string): { text: string; cut?: number } {
  const text = value.trim();
  if (text.length <= MAX_BODY_CHARS) return { text };
  return { text: text.slice(0, MAX_BODY_CHARS), cut: text.length - MAX_BODY_CHARS };
}

/** A tool's result is a string or a list of content blocks, depending on the tool. */
function flatten(value: unknown): string {
  if (typeof value === "string") return value;
  return list(value)
    .map((block) => {
      const one = record(block);
      return str(one["text"]) ?? `[${str(one["type"]) ?? "block"}]`;
    })
    .join("\n");
}

/**
 * What one transcript line is worth showing, which for a message is one moment
 * per content block. Lines this says nothing about are the ones a person reading
 * back cannot use: the CLI's own bookkeeping, and the preamble it writes itself.
 */
function momentsOf(entry: Record<string, unknown>): Moment[] {
  const at = str(entry["timestamp"]) ?? "";
  const type = entry["type"];

  const moments: Moment[] = [];

  if (type === "system") {
    const error = record(entry["error"]);
    const text = str(error["formatted"]) ?? str(error["message"]);
    if (text !== undefined) moments.push({ at, from: "note", text });
  } else if ((type === "user" || type === "assistant") && entry["isMeta"] !== true) {
    const content = record(entry["message"])["content"];

    if (typeof content === "string") {
      const said = body(content);
      if (said.text !== "") moments.push({ at, from: type === "user" ? "person" : "agent", ...said });
    }

    for (const block of list(content)) {
      const one = record(block);
      switch (one["type"]) {
        case "text": {
          const said = body(str(one["text"]) ?? "");
          if (said.text !== "") moments.push({ at, from: type === "user" ? "person" : "agent", ...said });
          break;
        }
        case "thinking": {
          // Empty on a model that keeps its reasoning to itself, and there is nothing to show for those.
          const thought = body(str(one["thinking"]) ?? "");
          if (thought.text !== "") moments.push({ at, from: "thought", ...thought });
          break;
        }
        case "tool_use":
          moments.push({
            at,
            from: "tool",
            tool: str(one["name"]) ?? "an unnamed tool",
            useId: str(one["id"]) ?? "",
            ...body(JSON.stringify(record(one["input"]), null, 2)),
          });
          break;
        case "tool_result":
          moments.push({
            at,
            from: "result",
            useId: str(one["tool_use_id"]) ?? "",
            ...(one["is_error"] === true ? { failed: true } : {}),
            ...body(flatten(one["content"])),
          });
          break;
        default:
          break;
      }
    }
  }

  return entry["isSidechain"] === true ? moments.map((moment) => ({ ...moment, aside: true })) : moments;
}

/**
 * The moments in a transcript from `from` bytes in, for a file being appended to
 * while it is read: the last line is left alone until its newline arrives, and
 * `next` is where the whole ones ended, so the caller asks for the rest later.
 *
 * A file shorter than `from` was replaced rather than appended to, so it is read
 * from the start again and `from` comes back as `0` to say so.
 */
export function readTranscript(path: string, from: number): Page {
  const handle = openSync(path, "r");
  let raw: string;
  let size: number;
  let start: number;
  try {
    size = fstatSync(handle).size;
    start = from > size || from < 0 || !Number.isSafeInteger(from) ? 0 : from;
    const length = size - start;
    if (length === 0) return { from: start, next: start, size, moments: [] };
    const buffer = Buffer.alloc(length);
    // Safe to decode from an offset because `from` is always the end of a line.
    raw = buffer.toString("utf8", 0, readSync(handle, buffer, 0, length, start));
  } finally {
    closeSync(handle);
  }

  const lastNewline = raw.lastIndexOf("\n");
  if (lastNewline === -1) return { from: start, next: start, size, moments: [] };
  const whole = raw.slice(0, lastNewline + 1);

  const moments: Moment[] = [];
  for (const line of whole.split("\n")) {
    if (line.trim() === "") continue;
    try {
      moments.push(...momentsOf(record(JSON.parse(line))));
    } catch {
      // A line this version cannot read is worth less than the rest of the transcript.
    }
  }

  return { from: start, next: start + Buffer.byteLength(whole), size, moments };
}
