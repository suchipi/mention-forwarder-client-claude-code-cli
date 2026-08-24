import type { Directive } from "./directive.ts";
import type { Mention } from "./mention.ts";
import type { ApprovalMode } from "./options.ts";
import type { Denial, Signal } from "./signals.ts";

/** Long tool arguments are summarized rather than dumped into a public comment. */
const MAX_ARGUMENT_CHARS = 300;

/**
 * Appended to the session's system prompt. Claude Code otherwise has every
 * reason to believe it is talking to someone at a terminal, and the difference
 * decides how it writes and whether it stops to ask.
 */
export function systemPrompt(approval: ApprovalMode): string {
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
    waiting[approval],
  ].join("\n\n");
}

/**
 * Told to the agent once per session, in the message rather than the system
 * prompt so it survives as part of the transcript.
 */
const FRAMING =
  "You are answering an @-mention that mention-forwarder picked up. Whatever you say in reply is posted back to that thread as a comment, so write for the people reading it there. Later mentions in the same thread arrive as further turns in this session.";

function attribution(mention: Mention): string {
  const via = [mention.platform, mention.kind].filter((part) => part !== "").join(" ");
  const who = mention.author === "" ? "someone" : `@${mention.author}`;
  const line = via === "" ? `from ${who}` : `from ${who} via ${via}`;
  return mention.url === "" ? line : `${line}\n${mention.url}`;
}

/** What the person actually wrote: the mention minus the trigger phrase, or the whole body when that leaves nothing. */
export function spokenText(mention: Mention): string {
  return mention.prompt.trim() === "" ? mention.text.trim() : mention.prompt.trim();
}

function orPlaceholder(body: string): string {
  return body.trim() === "" ? "(the mention had no text beyond the trigger phrase)" : body.trim();
}

/** The message that opens a session. Its first line becomes the session's name. */
export function firstMessage(mention: Mention, body: string): string {
  const heading = mention.title === "" ? `[${mention.conversationKey}]` : `[${mention.conversationKey}] ${mention.title}`;
  return `${heading}\n${attribution(mention)}\n\n${FRAMING}\n\n${orPlaceholder(body)}`;
}

/** The message for every later mention in a conversation the agent already has context for. */
export function followUpMessage(mention: Mention, body: string): string {
  return `${attribution(mention)}\n\n${orPlaceholder(body)}`;
}

/** Inline-code safe: a public reply is no place for a raw multi-line blob. */
function inlineCode(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").replaceAll("`", "").trim();
  return collapsed.length > MAX_ARGUMENT_CHARS ? `${collapsed.slice(0, MAX_ARGUMENT_CHARS)}...` : collapsed;
}

function describeInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return "";
  return inlineCode(JSON.stringify(input));
}

type Ask = Extract<Signal, { kind: "ask" }>;

function questionsIn(ask: Ask): string[] {
  const raw = ask.tool.input["questions"];
  if (!Array.isArray(raw)) return [];

  const blocks: string[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const one = entry as Record<string, unknown>;
    const question = typeof one["question"] === "string" ? one["question"].trim() : "";
    if (question === "") continue;

    const options = Array.isArray(one["options"])
      ? one["options"].flatMap((option) => {
          if (option === null || typeof option !== "object") return [];
          const value = option as Record<string, unknown>;
          const label = typeof value["label"] === "string" ? value["label"] : "";
          if (label === "") return [];
          const description = typeof value["description"] === "string" ? value["description"] : "";
          return [description === "" ? `- \`${label}\`` : `- \`${label}\`: ${description}`];
        })
      : [];

    blocks.push(options.length === 0 ? question : `${question}\n\n${options.join("\n")}`);
  }
  return blocks;
}

/**
 * `Bash` describes what its command does rather than what it acts on, so the
 * generic "run `X` on Y" sentence reads that summary as the thing acted upon.
 */
function bashPhrasing(ask: Ask): { what: string; rest: Record<string, unknown> } | undefined {
  if (ask.tool.name !== "Bash") return undefined;

  const command = ask.tool.input["command"];
  if (typeof command !== "string" || command.trim() === "") return undefined;

  const described = ask.description ?? ask.tool.input["description"];
  const summary = typeof described === "string" ? inlineCode(described) : "";
  const rest = Object.fromEntries(Object.entries(ask.tool.input).filter(([key]) => key !== "command" && key !== "description"));
  const shown = `the shell command \`${inlineCode(command)}\``;

  return { what: summary === "" ? shown : `${shown} (${summary})`, rest };
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
          : questions.map((question, index) => `${index + 1}. ${question}`).join("\n\n");
      return `The agent has a question:\n\n${body}\n\nReply here with your answer and it will carry on.`;
    }
    return `The agent is waiting on \`${ask.tool.name}\` for something only a person can give it. Reply here with your answer.`;
  }

  const bash = bashPhrasing(ask);
  const what =
    bash?.what ?? (ask.description === undefined ? `\`${ask.tool.name}\`` : `\`${ask.tool.name}\` on ${inlineCode(ask.description)}`);
  const args = describeInput(bash?.rest ?? ask.tool.input);
  const detail = args === "" ? "" : `\n\n\`${args}\``;
  const why = ask.reason === undefined ? "" : `\n\nWhy it is asking: ${inlineCode(ask.reason)}`;

  return `The agent needs permission before it can carry on. It wants to run ${what}.${detail}${why}\n\nReply \`approve\` to allow it. Any other reply refuses it, and what you write is given to the agent as the reason.`;
}

/** Given to `AskUserQuestion` as the tool's result, since the tool itself has nobody to ask. */
export function answerToQuestion(reply: string): string {
  return `The person you asked replied, in the thread: ${reply.trim()}\n\n(There is no interactive user here. Their answer arrived as a comment, which is why it comes back through this channel.)`;
}

/** Given to `AskUserQuestion` when nobody is going to be asked at all. */
export function nobodyToAsk(): string {
  return "There is nobody at a keyboard to answer that. Put the question in your reply and end your turn; whoever is watching the thread will answer it as a new mention.";
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
  const wanted = denials.map((denial) => `- \`${denial.toolName}\` ${inlineCode(JSON.stringify(denial.input))}`);
  return `The agent stopped short of running:\n\n${wanted.join("\n")}\n\nIt was refused because this bot runs unattended.`;
}

export function failureNotice(error: string): string {
  return `The turn failed: ${inlineCode(error)}`;
}

export function startupFailureNotice(detail: string): string {
  return `I could not start Claude Code: ${inlineCode(detail)}`;
}

/** Confirms a `[model=...]` group that carried no other instruction. */
export function directiveNotice(directive: Directive, applied: Directive): string {
  const parts: string[] = [];
  if (directive.model !== undefined) parts.push(`model \`${applied.model}\``);
  if (directive.effort !== undefined) parts.push(`effort \`${applied.effort}\``);
  return parts.length === 0 ? "Nothing to change." : `This thread is now on ${parts.join(" and ")}.`;
}
