import type { Mention } from "./mention.ts";

/** Whether this mention was written in a review thread on a pull request at all. */
export function isReviewComment(mention: Mention): boolean {
  return mention.platform === "github" && mention.kind === "pull_request_review_comment";
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/**
 * What a review thread's own conversation is remembered as, or undefined when
 * the mention was not written in one, or when nothing in it says which one.
 *
 * Every review comment on a pull request reaches this program under that pull
 * request's `conversationKey`, and its url names the comment rather than the
 * thread: each reply in a thread has an id, and so a permalink, of its own. What
 * ties them together is `in_reply_to_id`, which GitHub sets on every reply to
 * the comment the thread opens with, so the thread is that comment's id and the
 * opening comment is its own.
 *
 * That field only exists in the webhook payload, which reaches a command only
 * when mention-forwarder's `includeRawPayload` is on. Without it a comment
 * cannot be placed in a thread at all, and this says so rather than guessing: a
 * thread whose later comments could not be recognized would be given a session
 * that answered its first comment and never heard from it again.
 */
export function reviewThreadKey(mention: Mention): string | undefined {
  if (!isReviewComment(mention)) return undefined;
  const comment = record(record(mention.raw)?.["comment"]);
  if (comment === undefined) return undefined;
  const root = comment["in_reply_to_id"];
  const own = comment["id"];
  const thread = typeof root === "number" ? root : typeof own === "number" ? own : undefined;
  if (thread === undefined) return undefined;
  return `${mention.conversationKey}#review:${thread}`;
}
