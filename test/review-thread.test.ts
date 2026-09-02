import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Mention } from "../src/mention.ts";
import { isReviewComment, reviewThreadKey } from "../src/review-thread.ts";

const mention: Mention = {
  id: "a1",
  platform: "github",
  kind: "pull_request_review_comment",
  url: "https://github.com/acme/widgets/pull/7#discussion_r200",
  text: "@my-bot [fork] have a look",
  prompt: "[fork] have a look",
  author: "suchipi",
  title: "Extract the listbox",
  conversationKey: "github:acme/widgets#7",
  receivedAt: "2026-08-22T00:00:00.000Z",
  replyFile: "/tmp/reply.md",
};

/** A review comment payload, cut down to what places a comment in its thread. */
function payload(comment: Record<string, unknown>): unknown {
  return { action: "created", comment: { id: 200, ...comment }, pull_request: { number: 7 } };
}

function like(over: Partial<Mention>): Mention {
  return { ...mention, ...over };
}

describe("which review thread a comment is in", () => {
  it("reads the comment that opened the thread as the thread itself", () => {
    strictEqual(reviewThreadKey(like({ raw: payload({}) })), "github:acme/widgets#7#review:200");
  });

  it("reads a reply as the thread it was written in, not as one of its own", () => {
    // Every comment in a review thread has an id, and so a permalink, of its
    // own; in_reply_to_id is the only thing that says they are one thread.
    const reply = like({
      url: "https://github.com/acme/widgets/pull/7#discussion_r201",
      raw: payload({ id: 201, in_reply_to_id: 200 }),
    });
    strictEqual(reviewThreadKey(reply), "github:acme/widgets#7#review:200");
  });

  it("keeps two threads on one pull request apart", () => {
    const other = like({ raw: payload({ id: 300 }) });
    strictEqual(reviewThreadKey(other), "github:acme/widgets#7#review:300");
  });

  it("says nothing when the payload never arrived", () => {
    strictEqual(reviewThreadKey(mention), undefined);
    strictEqual(isReviewComment(mention), true);
  });

  it("says nothing rather than guessing when the payload is not the shape it expects", () => {
    for (const raw of [null, "a string", {}, { comment: null }, { comment: { id: "200" } }, { comment: {} }]) {
      strictEqual(reviewThreadKey(like({ raw })), undefined, JSON.stringify(raw));
    }
  });

  it("knows a comment that is not on a review at all when it sees one", () => {
    const issue = like({ kind: "issue_comment", raw: payload({}) });
    strictEqual(isReviewComment(issue), false);
    strictEqual(reviewThreadKey(issue), undefined);
    const linear = like({ platform: "linear", kind: "comment", raw: payload({}) });
    strictEqual(isReviewComment(linear), false);
    strictEqual(reviewThreadKey(linear), undefined);
  });
});
