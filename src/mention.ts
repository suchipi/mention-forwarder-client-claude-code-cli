import { createInterface } from "node:readline";
import type { Logger } from "./logger.ts";

/**
 * One @-mention as mention-forwarder serializes it. Field names are its public
 * interface, mirrored here rather than imported because the two programs are
 * separate installs: see the "How your command receives the mention" section of
 * https://github.com/suchipi/mention-forwarder.
 */
export type Mention = {
  /** Unique per delivery. */
  id: string;
  /** `github`, `slack`, or `linear`. */
  platform: string;
  /** Platform event name, e.g. `issue_comment`, `app_mention`, `comment`. */
  kind: string;
  /** Permalink to the comment or message that did the mentioning. */
  url: string;
  /** The body of the comment or message, verbatim. */
  text: string;
  /** `text` with the mention itself removed. */
  prompt: string;
  /** Display name or handle of whoever wrote it. */
  author: string;
  /** Issue or PR title, or the Slack channel id. Empty when the platform offers none. */
  title: string;
  /** Identifies the thread. One Claude Code session is kept per distinct value. */
  conversationKey: string;
  receivedAt: string;
  /** Path to append replies to; mention-forwarder posts what lands there. */
  replyFile: string;
  /**
   * The webhook payload the mention was read out of, which mention-forwarder
   * sends only when its `includeRawPayload` is on. Read for the one thing the
   * normalized fields cannot say: which review thread a GitHub review comment
   * belongs to.
   */
  raw?: unknown;
};

/** Past this many buffered bytes, input that never parses is discarded rather than kept forever. */
const MAX_BUFFERED_BYTES = 1024 * 1024;

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") throw new Error(`mention has no "${key}"`);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

/** Narrows a parsed JSON value to a Mention, throwing when a field this program needs is absent. */
export function toMention(value: unknown): Mention {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("mention is not a JSON object");
  }
  const record = value as Record<string, unknown>;
  return {
    id: requireString(record, "id"),
    conversationKey: requireString(record, "conversationKey"),
    replyFile: requireString(record, "replyFile"),
    platform: optionalString(record, "platform"),
    kind: optionalString(record, "kind"),
    url: optionalString(record, "url"),
    text: optionalString(record, "text"),
    prompt: optionalString(record, "prompt"),
    author: optionalString(record, "author"),
    title: optionalString(record, "title"),
    receivedAt: optionalString(record, "receivedAt"),
    ...("raw" in record ? { raw: record["raw"] } : {}),
  };
}

/**
 * Yields each mention written to `input`, in arrival order, until it closes.
 *
 * A `per-conversation` command is fed one compact object per line, but a
 * `per-mention` one gets a single pretty-printed object, so lines are buffered
 * until they parse and either shape works. Input that is not a usable mention is
 * reported and skipped rather than ending the stream.
 */
export async function* readMentions(input: NodeJS.ReadableStream, log: Logger): AsyncGenerator<Mention> {
  let buffered = "";

  for await (const line of createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })) {
    if (buffered === "" && line.trim() === "") continue;
    buffered = buffered === "" ? line : `${buffered}\n${line}`;

    let parsed: unknown;
    try {
      parsed = JSON.parse(buffered);
    } catch {
      // A mention is always an object, so anything else can never become one by
      // reading further lines.
      if (!buffered.trimStart().startsWith("{")) {
        log.warn("ignoring input that is not JSON", { input: buffered.slice(0, 200) });
        buffered = "";
      } else if (buffered.length > MAX_BUFFERED_BYTES) {
        log.warn("discarding buffered input that never became valid JSON", { bytes: buffered.length });
        buffered = "";
      }
      continue;
    }

    buffered = "";
    try {
      yield toMention(parsed);
    } catch (error) {
      log.warn("ignoring unusable mention", { error: (error as Error).message });
    }
  }

  if (buffered.trim() !== "") log.warn("input ended mid-object", { bytes: buffered.length });
}
