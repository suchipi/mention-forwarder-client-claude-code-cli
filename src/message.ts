import { APPROVALS } from "./answer.ts";
import type { Mention } from "./mention.ts";
import { describeSettings, type ApprovalMode, type ThreadSettings } from "./settings.ts";
import { reviewThreadKey } from "./review-thread.ts";
import type { Denial, Signal } from "./signals.ts";

/** Long tool arguments are summarized rather than dumped into a public comment. */
const MAX_ARGUMENT_CHARS = 300;

/** Nothing is said when the mention carried no permalink: pointing at a thread needs an address. */
function threadContext(mention: Mention): string[] {
  if (mention.url === "") return [];
  const where = mention.platform === "" ? `at ${mention.url}` : `on ${mention.platform}, at ${mention.url}`;
  return [
    `The thread you are answering in is ${where}. Only the mentions themselves reach you, so read the rest of it for context before you answer, with whatever tool can reach that platform.`,
  ];
}

/** Where a session is to write down what it opened, and the name it writes down as. */
export type ForkRecord = { path: string; from: string };

/**
 * How the agent is asked to record a pull request it opens, so the thread that
 * pull request becomes can pick up where this one left off. Asking is the only
 * way: the agent is the only thing here that knows a pull request happened.
 */
function forkNote(record: ForkRecord): string {
  return [
    `When you open a pull request, write it down, so that mentions arriving on that pull request reach an agent that already knows this work: append one line to ${record.path}, exactly {"url": "<the pull request's url>", "from": "${record.from}"} with the url filled in, as soon as the pull request exists.`,
    "Append it with a shell redirect (>>) rather than rewriting the file, because other threads are writing down their own work in it at the same time.",
    "A mention that arrives on a url recorded there starts as a fork of the session that recorded it, carrying everything said here into that thread. Nothing else belongs in that file.",
  ].join(" ");
}

/**
 * Told to every run of a thread whose session began as a copy of another one's,
 * because the thread it was copied from is still live and has an agent of its own
 * in the same working directory. Nothing here keeps the two apart; the most this
 * can do is say so, in the one place the agent reads before it touches anything.
 *
 * It names the worktree in the history rather than only asking for one, because
 * the history it copied is one in which the agent made a worktree and worked in
 * it, so an agent told to work in a worktree of its own reads that as already
 * done and carries on in the thread it was forked from.
 */
const FORKED =
  "This thread's session was forked from another thread's, which is still live and has an agent of its own working in the same directory. Any worktree or branch named above belongs to that thread rather than to you, however much of the history above reads as your own doing, and its files can change under you between one step and the next. Before you change anything, make a git worktree of your own and work only in it; git will not check out a branch that is checked out elsewhere, so where your work belongs on that branch, take a detached worktree at its head and push from there.";

/**
 * Appended to the session's system prompt. Claude Code otherwise has every
 * reason to believe it is talking to someone at a terminal, and the difference
 * decides how it writes and whether it stops to ask.
 *
 * `mention` is the one the session is being started for; a session serves one
 * thread, so its thread is every later mention's thread too.
 *
 * `extra` is whatever the operator put in `appendSystemPrompt`, added last so
 * their standing instructions read as the final word on how the bot behaves.
 * `record` is last as an argument and second to last in the prompt, for that
 * same reason, and `forked` after it for no reason but that it came later.
 */
export function systemPrompt(
  approval: ApprovalMode,
  mention?: Mention,
  extra?: string,
  record?: ForkRecord,
  forked?: boolean,
): string {
  const waiting: Record<ApprovalMode, string> = {
    ask: "When you need permission to run a tool, or ask a question with AskUserQuestion, it is posted to the thread and your turn waits there until somebody answers, which can take hours. Do everything that does not depend on the answer first.",
    allow:
      "Tool permissions are approved automatically, so nothing stops for those. A question you ask with AskUserQuestion is posted to the thread and your turn waits there until somebody answers, which can take hours. Do everything that does not depend on the answer first.",
    deny: "Tool permissions are refused automatically and nobody is watching, so do not use AskUserQuestion. If you need something a refused tool would have done, say so in your reply and end your turn.",
  };

  return [
    "You are running as a bot that answers @-mentions forwarded from GitHub, Slack, and Linear.",
    "Everything you say in reply is posted back to the thread the mention came from, as a comment. Write for the people reading it there, not for a terminal: no ANSI colour, no clearing the screen, no assuming anyone can see your working directory.",
    "Nobody is at a keyboard. A person sees your reply only once it is posted as a comment, and answers by writing another comment, which reaches you as a further turn in this session.",
    "Everything a person says here reaches you labelled with who wrote it. More than one of them can be in the same thread, so read the label before you attribute anything, and quote the right person.",
    ...(mention === undefined ? [] : threadContext(mention)),
    waiting[approval],
    ...(forked === true ? [FORKED] : []),
    ...(record === undefined ? [] : [forkNote(record)]),
    ...(extra === undefined || extra.trim() === "" ? [] : [extra.trim()]),
  ].join("\n\n");
}

/**
 * Told to the agent once per session, in the message rather than the system
 * prompt so it survives as part of the transcript.
 */
const FRAMING =
  "You are answering an @-mention that mention-forwarder picked up. Whatever you say in reply is posted back to that thread as a comment, so write for the people reading it there. Later mentions in the same thread arrive as further turns in this session.";

/** How a person is named to the agent, `@`-prefixed as their platform writes it. */
function speaker(mention: Mention): string {
  return mention.author === "" ? "someone" : `@${mention.author}`;
}

/** What the person actually wrote: the mention minus the trigger phrase, or the whole body when that leaves nothing. */
export function spokenText(mention: Mention): string {
  return mention.prompt.trim() === ""
    ? mention.text.trim()
    : mention.prompt.trim();
}

function orPlaceholder(body: string): string {
  return body.trim() === ""
    ? "(the mention had no text beyond the trigger phrase)"
    : body.trim();
}

/**
 * A person's words, under one line saying who wrote them and how it reached the
 * agent. Every message carries it, because a thread has more than one person in
 * it and quoting one of them as another is worse than not quoting at all.
 *
 * Above the words rather than in front of them, so a body that opens with a code
 * fence, a heading or a quote still reads as one, and last in its message, so
 * the label is never separated from what it names. The permalink is
 * parenthetical because the colon has to be the last thing on the line:
 * whatever follows it reads as part of what was said.
 *
 * `body` is what is left once a `[...]` group has been taken off the front, so a
 * label never lands in front of one and nothing here can stop `[stop]` parsing.
 */
function said(mention: Mention, body: string): string {
  const via = [mention.platform, mention.kind]
    .filter((part) => part !== "")
    .join(" ");
  const how = [
    via === "" ? "" : `, via ${via}`,
    mention.url === "" ? "" : ` (${mention.url})`,
  ].join("");
  return `${speaker(mention)} said${how}:\n${orPlaceholder(body)}`;
}

/** Names the thread a message opens, as its own first line. */
function heading(mention: Mention, key = mention.conversationKey): string {
  return mention.title === "" ? `[${key}]` : `[${key}] ${mention.title}`;
}

/** The message that opens a session. Its first line becomes the session's name. */
export function firstMessage(mention: Mention, body: string): string {
  return `${heading(mention)}\n\n${FRAMING}\n\n${said(mention, body)}`;
}

/**
 * The message that opens a session forked from the one that did the work this
 * thread is about. What that thread said is already above it, which is the whole
 * point and also the danger: without this the agent reads the thread it is now in
 * as the one it was in, and answers people who cannot see what it is answering.
 */
export function carriedOverMessage(mention: Mention, body: string, cameFrom: string): string {
  return `${heading(mention)}\n\nThis is a new thread, and it is not the one everything above came from. That was the thread this work started in, and it is here because ${cameFrom} came out of it. Answer in this thread from now on: nobody reading here saw the other one, so take nothing said there as already said, and point at it only when you mean to send somebody there.\n\n${said(mention, body)}`;
}

/**
 * The message that opens a session split off the one its pull request is on, for
 * a single review thread on that pull request.
 *
 * Everything above it was said on the pull request as a whole, and this thread
 * is a corner of it: the people reading here see only what is written in this
 * one thread, and the pull request's own thread carries on beside this session
 * without anything said here reaching it.
 */
export function splitOffMessage(mention: Mention, body: string, key: string): string {
  return `${heading(mention, key)}\n\nThis is one review thread on the pull request everything above was said on, and it has this session to itself from here. Answer in this thread from now on: what you say goes back as a reply in it, where the rest of the pull request is not reading, and the pull request's own thread has a session of its own that carries on without you. Take nothing said above as said here, and point at it only when you mean to send somebody there.\n\n${said(mention, body)}`;
}

/** The message for every later mention in a conversation the agent already has context for. */
export function followUpMessage(mention: Mention, body: string): string {
  return said(mention, body);
}

/**
 * The message for a mention that reached a turn already running. It says so,
 * because the agent is part-way through something and would otherwise read this
 * as the next thing to do rather than a change to what it is already doing. It
 * may also be from somebody other than whoever started the turn, which is why it
 * is labelled here as on any other mention.
 */
export function steerMessage(mention: Mention, body: string): string {
  return `This arrived while you were still working, so it changes the turn you are on rather than starting another one. Take it into account from here, and answer it as part of this turn.\n\n${said(mention, body)}`;
}

/** Inline-code safe: a public reply is no place for a raw multi-line blob. */
function inlineCode(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").replaceAll("`", "").trim();
  return collapsed.length > MAX_ARGUMENT_CHARS
    ? `${collapsed.slice(0, MAX_ARGUMENT_CHARS)}...`
    : collapsed;
}

/** Grouped, because a token count is read at a glance or not at all. */
function tokens(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function describeInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return "";
  return inlineCode(JSON.stringify(input));
}

type Ask = Extract<Signal, { kind: "ask" }>;
type Compacted = Extract<Signal, { kind: "compacted" }>;

function questionsIn(ask: Ask): string[] {
  const raw = ask.tool.input["questions"];
  if (!Array.isArray(raw)) return [];

  const blocks: string[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const one = entry as Record<string, unknown>;
    const question =
      typeof one["question"] === "string" ? one["question"].trim() : "";
    if (question === "") continue;

    const options = Array.isArray(one["options"])
      ? one["options"].flatMap((option) => {
          if (option === null || typeof option !== "object") return [];
          const value = option as Record<string, unknown>;
          const label =
            typeof value["label"] === "string" ? value["label"] : "";
          if (label === "") return [];
          const description =
            typeof value["description"] === "string"
              ? value["description"]
              : "";
          return [
            description === ""
              ? `- \`${label}\``
              : `- \`${label}\`: ${description}`,
          ];
        })
      : [];

    blocks.push(
      options.length === 0 ? question : `${question}\n\n${options.join("\n")}`,
    );
  }
  return blocks;
}

/**
 * `Bash` describes what its command does rather than what it acts on, so the
 * generic "run `X` on Y" sentence reads that summary as the thing acted upon.
 */
function bashPhrasing(
  ask: Ask,
): { what: string; rest: Record<string, unknown> } | undefined {
  if (ask.tool.name !== "Bash") return undefined;

  const command = ask.tool.input["command"];
  if (typeof command !== "string" || command.trim() === "") return undefined;

  const described = ask.description ?? ask.tool.input["description"];
  const summary = typeof described === "string" ? inlineCode(described) : "";
  const rest = Object.fromEntries(
    Object.entries(ask.tool.input).filter(
      ([key]) => key !== "command" && key !== "description",
    ),
  );
  const shown = `the shell command \`${inlineCode(command)}\``;

  return { what: summary === "" ? shown : `${shown} (${summary})`, rest };
}

/**
 * Every word that means yes, listed rather than exemplified: a person reading a
 * request in a thread has nowhere else to look up what counts as approving it.
 */
function howToApprove(): string {
  const words = [...APPROVALS].map((word) => (/^[a-z ]+$/.test(word) ? `\`${word}\`` : word)).join(", ");
  return `Reply with any of these, and nothing else, to allow it: ${words}. Any other reply refuses it, and what you write is given to the agent as the reason.`;
}

/**
 * What to post when a turn stops for a person. Written in plain text with code
 * spans only, because the same string goes to GitHub, Slack, and Linear, and
 * Slack of the three ignores most markdown.
 */
export function askNotice(ask: Ask): string {
  if (ask.isQuestion) {
    const questions = questionsIn(ask);
    if (questions.length > 0) {
      const body =
        questions.length === 1
          ? questions[0]
          : questions
              .map((question, index) => `${index + 1}. ${question}`)
              .join("\n\n");
      return `The agent has a question:\n\n${body}\n\nReply here with your answer — one of the labels above, or your own words — and it will carry on.`;
    }
    // Not every tool that stops for a person lays its ask out the way
    // `AskUserQuestion` does, so what it was called with is all there is to show.
    const on = ask.description === undefined ? "" : ` on ${inlineCode(ask.description)}`;
    const args = describeInput(ask.tool.input);
    const detail = args === "" ? "" : `\n\n\`${args}\``;
    return `The agent is waiting on \`${ask.tool.name}\`${on} for something only a person can give it.${detail}\n\nReply here with your answer, in your own words: whatever you write is handed to the agent.`;
  }

  const bash = bashPhrasing(ask);
  const what =
    bash?.what ??
    (ask.description === undefined
      ? `\`${ask.tool.name}\``
      : `\`${ask.tool.name}\` on ${inlineCode(ask.description)}`);
  const args = describeInput(bash?.rest ?? ask.tool.input);
  const detail = args === "" ? "" : `\n\n\`${args}\``;
  const why =
    ask.reason === undefined
      ? ""
      : `\n\nWhy it is asking: ${inlineCode(ask.reason)}`;

  return `The agent needs permission before it can carry on. It wants to run ${what}.${detail}${why}\n\n${howToApprove()}`;
}

/** Given to `AskUserQuestion` as the tool's result, since the tool itself has nobody to ask. */
export function answerToQuestion(mention: Mention, reply: string): string {
  return `${speaker(mention)} answered, in the thread: ${reply.trim()}\n\n(There is no interactive user here. Their answer arrived as a comment, which is why it comes back through this channel.)`;
}

/** Given to a tool the thread turned down, as the reason the agent is shown. */
export function refusalFrom(mention: Mention, reply: string): string {
  return reply.trim() === ""
    ? `${speaker(mention)} did not approve it.`
    : `${speaker(mention)} refused it, in the thread: ${reply.trim()}`;
}

/** Given to `AskUserQuestion` when nobody is going to be asked at all. */
export function nobodyToAsk(): string {
  return "There is nobody at a keyboard to answer that. Put the question in your reply and end your turn; whoever is watching the thread will answer it as a new mention.";
}

/**
 * Whether an answer to this mention is posted to the conversation as a whole
 * rather than under the comment itself, which is what decides whether two
 * mentions from one conversation are answered in the same place.
 *
 * mention-forwarder answers a Slack mention in the thread the conversation is
 * keyed on, and a GitHub issue comment, review summary or commit comment on the
 * issue, pull request or commit. A GitHub review comment, a GitHub discussion
 * comment and any Linear comment are the exceptions: each is answered under the
 * comment it hangs off, so two comments in one conversation are answered in two
 * places. Anything not named here is read as one of those, because a pointer
 * nobody needed reads better than an answer nobody can find.
 */
function answeredToTheConversation(mention: Mention): boolean {
  if (mention.platform === "slack") return true;
  return (
    mention.platform === "github" &&
    (mention.kind === "issue_comment" ||
      mention.kind === "pull_request_review" ||
      mention.kind === "commit_comment")
  );
}

/**
 * Whether an answer to one of these mentions is posted where an answer to the
 * other would be.
 *
 * Two comments in one GitHub review thread are the other way this happens, and
 * it holds whether or not that thread has [forked](../README.md#forking-a-review-thread):
 * mention-forwarder answers a review comment by replying to it, and GitHub puts
 * that reply in the thread the comment is in, so both answers land in the thread
 * both were written in. Only the webhook payload says which thread that is, so a
 * comment that cannot be placed in one keeps its pointer.
 */
function answeredTogether(one: Mention, other: Mention): boolean {
  if (one.conversationKey !== other.conversationKey) return false;
  if (answeredToTheConversation(one) && answeredToTheConversation(other)) return true;
  const thread = reviewThreadKey(one);
  return thread !== undefined && thread === reviewThreadKey(other);
}

/**
 * Posted to the comment that reached a turn already running. Nothing comes back
 * from the CLI to say a mid-turn message landed, so without this the thread sees
 * nothing at all until the turn ends. The turn answers where it started, so this
 * is also the only pointer this comment gets to its own answer.
 *
 * Nothing at all when that answer is coming to the same thread this would be
 * posted in, or when there is no permalink to point at: the pointer is the whole
 * reason to speak, and the answer landing there says everything this would have.
 */
export function steeredNotice(
  owner: Mention,
  steerer: Mention,
): string | undefined {
  if (owner.url === "" || answeredTogether(owner, steerer)) return undefined;
  return `The agent is already working here, so this went to it as it runs. It picks this up at its next step and answers it as part of the turn it is on. That turn replies where it started, so the answer appears there: ${owner.url}`;
}

/** Posted once a turn somebody called off has actually stopped. */
export function interruptedNotice(): string {
  return "Stopped, as asked.";
}

/** Posted when an interrupt found nothing to stop, which a turn that finished on its own moments earlier will do. */
export function nothingToInterrupt(): string {
  return "Nothing was running, so there was nothing to stop.";
}

/** Posted once the thread's `claude` process has been ended. */
export function exitedNotice(hadTurn: boolean): string {
  const lost = hadTurn ? " The turn it was running went with it." : "";
  return `Ended the Claude Code process.${lost} The next mention here starts a new one on the same session, so the thread keeps its history.`;
}

/** Posted when an exit found no process, which an idle session closed by mention-forwarder will do. */
export function nothingToExit(): string {
  return "Claude Code was not running here, so there was nothing to end. The next mention starts it.";
}

/**
 * Posted when a fork found no session to copy, which is the one outcome of a
 * fork worth a comment: the thread asked to carry on from the pull request's
 * work and got a thread of its own that knows none of it.
 */
export function forkedFromNothingNotice(): string {
  return "There was nothing to copy into this review thread: nothing has run in this pull request's own thread yet, so there was no session to fork. The thread has one of its own from here all the same, and it starts knowing only what is written in it.";
}

/** Posted when a review thread that already has a session of its own is asked for another. */
export function alreadyForkedNotice(): string {
  return "This review thread already has a session of its own, so I cannot fork it again: everything written here since it was forked has gone to that session, and a second one would answer from here knowing only the half it had seen. Say what you want it to do and it carries on from where it is.";
}

/** Posted when `[fork]` was written somewhere there is no review thread to give a session to. */
export function nothingToForkHere(): string {
  return "`[fork]` gives one GitHub review thread a session of its own, so it only means something written in a review comment. Nothing was forked, and this comment is answered in the thread as it always was.";
}

/**
 * Posted when a review comment cannot be placed in its thread, which is every
 * one of them unless mention-forwarder is passing the webhook payload on.
 */
export function cannotFollowTheReviewThread(): string {
  return "I cannot tell which review thread this comment is in, so forking it would strand the new session at this one comment: only the webhook payload says which thread a review comment belongs to, and mention-forwarder passes it on only when `includeRawPayload` is on. Turn that on and `[fork]` works here.";
}

/** Posted once a thread's history has been thrown away. */
export function clearedNotice(hadHistory: boolean): string {
  return hadHistory
    ? "Cleared this thread's context. The next mention here opens a new Claude Code session, which starts out knowing nothing of what was said before it. Its model and effort are unchanged."
    : "There was no history here to clear: nothing has run in this thread yet. The next mention opens a session for it.";
}

/** Posted when a compaction found no history to summarize. */
export function nothingToCompact(): string {
  return "There is no history here to compact: nothing has run in this thread yet. The next mention opens a session for it.";
}

/**
 * Posted once a compaction this thread asked for has finished, however it went.
 * A compaction has no model turn of its own, so this is the whole of what the
 * thread hears about one.
 */
export function compactedNotice(outcome: Compacted | undefined): string {
  if (outcome === undefined) {
    return "I asked Claude Code to compact this thread's context, and it finished without saying whether it had. Its log has whatever it did say.";
  }
  if (!outcome.ok) {
    return `I could not compact this thread's context: ${inlineCode(outcome.error ?? "no reason given")}`;
  }
  const sizes =
    outcome.preTokens === undefined || outcome.postTokens === undefined
      ? ""
      : ` ${tokens(outcome.preTokens)} tokens of it became ${tokens(outcome.postTokens)}.`;
  return `Compacted this thread's context: everything said here so far is a summary of itself now, and the thread carries on from that.${sizes}`;
}

export function refusedByPolicy(toolName: string): string {
  return `\`${toolName}\` was refused: this bot runs with every permission request denied.`;
}

export function askTimedOut(): string {
  return "Nobody answered in the thread in time, so this was refused. Say what you would have done and end your turn.";
}

export function noMoreAnswers(): string {
  return "No further mentions can reach this run, so nobody can answer that. Say what you would have done and end your turn.";
}

/** Posted when a turn ends with tools the agent was never allowed to run. */
export function denialNotice(denials: Denial[]): string {
  const wanted = denials.map(
    (denial) =>
      `- \`${denial.toolName}\` ${inlineCode(JSON.stringify(denial.input))}`,
  );
  return `The agent stopped short of running:\n\n${wanted.join("\n")}\n\nIt was refused because this bot runs unattended.`;
}

export function failureNotice(error: string): string {
  return `The turn failed: ${inlineCode(error)}`;
}

export function startupFailureNotice(detail: string): string {
  return `I could not start Claude Code: ${inlineCode(detail)}`;
}

/** Confirms a group of settings, whether it carried an instruction as well or stood alone. */
export function directiveNotice(settings: ThreadSettings): string {
  const parts = describeSettings(settings);
  if (parts.length === 0) return "Nothing to change.";
  const last = parts.at(-1);
  const listed = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${last}`;
  return `This thread is now on ${listed}.`;
}
