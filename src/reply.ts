import { appendFileSync } from "node:fs";
import type { Logger } from "./logger.ts";

export type Reply = {
  /** Appends one block to a mention's reply file. Blank blocks are dropped. */
  append(replyFile: string, text: string): void;
};

/**
 * The whole protocol back to mention-forwarder: append to the file it named, and
 * it posts what was added. Writing nothing keeps the bot silent, so a failure to
 * write costs a reply and never the run.
 */
export function createReply(log: Logger): Reply {
  return {
    append(replyFile, text) {
      const body = text.trim();
      if (body === "") return;
      try {
        // Blank line after each block: several appends can be posted as one
        // comment, and paragraphs run together without it.
        appendFileSync(replyFile, `${body}\n\n`);
      } catch (error) {
        log.error("could not write the reply file", { replyFile, error: (error as Error).message });
      }
    },
  };
}
