import {
  afterDirective,
  type Conversation,
  type ConversationDeps,
  type ConversationSnapshot,
  createConversation,
  type SplitFrom,
} from "./conversation.ts";
import { type Parsed, parseDirective } from "./directive.ts";
import * as say from "./message.ts";
import type { Mention } from "./mention.ts";
import { isReviewComment, reviewThreadKey } from "./review-thread.ts";

export type ThreadsDeps = Omit<ConversationDeps, "key" | "splitFrom">;

export type Threads = {
  handle(mention: Mention): Promise<void>;
  /** What each conversation here is doing, the one this process was started for first. */
  snapshots(): ConversationSnapshot[];
  /** Waits for every conversation to finish what it has been handed. */
  finish(): Promise<void>;
  /** Settles everything outstanding and ends every `claude` process. */
  stop(): Promise<void>;
};

/**
 * The conversations this process is running, and which mention belongs to which.
 *
 * mention-forwarder gives a process one conversation, and a pull request is one
 * conversation however many review threads are open on it: every review comment
 * on it arrives here under the same key, to be answered by one session, one turn
 * at a time. A review thread can ask to come out of that with `[fork]`, and from
 * then on it is a conversation of its own — its own session, forked off the pull
 * request's so it knows the work, and its own `claude` running beside it rather
 * than behind it, which is the whole point: two review threads being answered at
 * once, neither waiting on the other.
 *
 * Which review thread a comment is in is the one thing that cannot be worked out
 * from the mention alone; see `review-thread.ts` for what it takes.
 */
export function createThreads(deps: ThreadsDeps): Threads {
  const { options, store, reply, log } = deps;
  const base = createConversation(deps);
  /** One per review thread that has a session of its own, under the key it is remembered by. */
  const split = new Map<string, Conversation>();

  function conversationFor(key: string, splitFrom?: SplitFrom): Conversation {
    const running = split.get(key);
    if (running !== undefined) return running;
    const made = createConversation({ ...deps, key, splitFrom });
    split.set(key, made);
    return made;
  }

  function all(): Conversation[] {
    return [base, ...split.values()];
  }

  function splitOf(mention: Mention): SplitFrom {
    return {
      request: { url: mention.url, from: mention.conversationKey },
      point: base.forkPoint(mention),
    };
  }

  /** Gives the review thread a comment was written in a session of its own, or says why it cannot. */
  async function fork(mention: Mention, key: string | undefined, parsed: Parsed): Promise<void> {
    if (key === undefined) {
      const unplaceable = isReviewComment(mention);
      log.info(unplaceable ? "cannot tell which review thread this comment is in" : "nothing here to fork", {
        kind: mention.kind,
        url: mention.url,
      });
      reply.append(mention.replyFile, unplaceable ? say.cannotFollowTheReviewThread() : say.nothingToForkHere());
      return;
    }
    if (split.has(key) || store.get(key) !== undefined) {
      log.info("this review thread already has a session of its own", { key, url: mention.url });
      reply.append(mention.replyFile, say.alreadyForkedNotice());
      return;
    }

    const from = splitOf(mention);
    const conversation = conversationFor(key, from);
    // Written down before anything has run here, because the thread is forked from
    // this moment whatever comes of it: this entry is what a second `[fork]` finds,
    // and what sends the thread's later mentions here rather than to the pull request.
    store.set(key, { cwd: options.cwd, model: from.point.model, effort: from.point.effort });
    log.info("giving a review thread a session of its own", {
      key,
      url: mention.url,
      forkedFrom: from.point.sessionId,
    });
    reply.append(
      mention.replyFile,
      from.point.sessionId === undefined ? say.forkedFromNothingNotice() : say.forkedNotice(),
    );

    const next = afterDirective(mention, parsed);
    if (next !== undefined) await conversation.handle(next);
  }

  return {
    async handle(mention) {
      const key = reviewThreadKey(mention);
      // Read before the mention is routed anywhere, because it is the one thing a
      // comment can say that is about which conversation should be answering it.
      const parsed = parseDirective(say.spokenText(mention));
      if (parsed.directive.fork === true) return fork(mention, key, parsed);
      if (key === undefined) return base.handle(mention);

      const running = split.get(key);
      if (running !== undefined) return running.handle(mention);

      const remembered = store.get(key);
      if (remembered === undefined) return base.handle(mention);
      // A process that ended took its conversations with it, and this entry is all
      // that is left of one. An entry with no session is a thread that was forked
      // and never got to run, which still wants the thread it was split off.
      return conversationFor(
        key,
        remembered.sessionId === undefined ? splitOf(mention) : undefined,
      ).handle(mention);
    },

    snapshots() {
      return all().map((one) => one.snapshot());
    },

    async finish() {
      await Promise.all(all().map((one) => one.finish()));
    },

    async stop() {
      await Promise.all(all().map((one) => one.stop()));
    },
  };
}
