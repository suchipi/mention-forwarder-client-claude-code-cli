import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDirective } from "../src/directive.ts";
import * as say from "../src/message.ts";
import type { Mention } from "../src/mention.ts";
import type { Signal } from "../src/signals.ts";

type Ask = Extract<Signal, { kind: "ask" }>;

const mention: Mention = {
  id: "a1",
  platform: "github",
  kind: "issue_comment",
  url: "https://github.com/acme/widgets/issues/7#issuecomment-100",
  text: "@my-bot please fix the flaky test",
  prompt: "please fix the flaky test",
  author: "suchipi",
  title: "Flaky test in CI",
  conversationKey: "github:acme/widgets#7",
  receivedAt: "2026-08-22T00:00:00.000Z",
  replyFile: "/tmp/reply.md",
};

function ask(over: Partial<Ask> = {}): Ask {
  return {
    kind: "ask",
    requestId: "r1",
    tool: {
      name: "Write",
      input: { file_path: "/repo/notes.txt", content: "hi" },
      toolUseId: "t1",
    },
    isQuestion: false,
    title: undefined,
    description: undefined,
    reason: undefined,
    ...over,
  };
}

describe("what the agent is told", () => {
  it("opens a session with the thread, the author, and the link", () => {
    const opening = say.firstMessage(mention, "please fix the flaky test");
    match(opening, /^\[github:acme\/widgets#7\] Flaky test in CI\n/);
    match(opening, /@suchipi said, via github issue_comment \(https:\S+\):/);
    match(
      opening,
      /https:\/\/github\.com\/acme\/widgets\/issues\/7#issuecomment-100/,
    );
    match(opening, /posted back to that thread as a comment/);
    match(opening, /@suchipi said, via github issue_comment \(https:\S+\):\nplease fix the flaky test$/);
  });

  it("leaves the framing out of every later message", () => {
    const later = say.followUpMessage(mention, "also update the changelog");
    doesNotMatch(later, /posted back to that thread as a comment/);
    match(later, /@suchipi said, via github issue_comment \(https:\S+\):\nalso update the changelog$/);
  });

  it("says something when the mention was only the trigger phrase", () => {
    match(
      say.followUpMessage(mention, ""),
      /no text beyond the trigger phrase/,
    );
  });

  it("tells a steered agent this changes the turn rather than starting one", () => {
    const steer = say.steerMessage(mention, "check the release branch instead");
    // Repeated because whoever steers a turn need not be whoever started it.
    match(steer, /@suchipi said, via github issue_comment \(https:\S+\):/);
    match(steer, /while you were still working/);
    match(steer, /part of this turn/);
    doesNotMatch(steer, /posted back to that thread as a comment/);
    match(steer, /@suchipi said, via github issue_comment \(https:\S+\):\ncheck the release branch instead$/);
  });

  it("names whoever wrote a message once, on every kind of message", () => {
    for (const message of [
      say.firstMessage(mention, "do the thing"),
      say.followUpMessage(mention, "do the thing"),
      say.steerMessage(mention, "do the thing"),
    ]) {
      match(message, /@suchipi said, via github issue_comment \(https:\S+\):\ndo the thing$/);
      strictEqual(message.match(/@suchipi/g)?.length, 1, message);
    }
  });

  it("calls an author-less mention someone rather than dropping the label", () => {
    const anonymous = { ...mention, author: "" };
    match(say.followUpMessage(anonymous, "x"), /^someone said, via github/m);
    match(say.followUpMessage(anonymous, ""), /\):\n\(the mention had no text/);
  });

  it("leaves out what the mention did not carry", () => {
    const bare = { ...mention, platform: "", kind: "", url: "" };
    strictEqual(say.followUpMessage(bare, "do the thing"), "@suchipi said:\ndo the thing");
  });

  it("tells the agent the labels are there and what to do with them", () => {
    match(say.systemPrompt("ask"), /labelled with who wrote it/);
    match(say.systemPrompt("ask"), /quote the right person/);
  });

  it("labels the words a group left behind, not the group itself", () => {
    // Put the label in front instead and `[stop]` stops matching, so the turn it
    // was meant to call off keeps running.
    const raw = {
      ...mention,
      text: "@my-bot [stop] do this instead",
      prompt: "[stop] do this instead",
    };
    const parsed = parseDirective(say.spokenText(raw));
    strictEqual(parsed.directive.interrupt, true);

    const later = say.followUpMessage(raw, parsed.rest);
    match(later, /@suchipi said, via github issue_comment \(https:\S+\):\ndo this instead$/);
    doesNotMatch(later, /\[stop\]/);
  });

  it("names whoever answered a question and whoever refused a tool", () => {
    match(
      say.answerToQuestion(mention, "  spaces  "),
      /^@suchipi answered, in the thread: spaces$/m,
    );
    match(
      say.refusalFrom(mention, "no, that file is generated"),
      /^@suchipi refused it, in the thread: no, that file is generated$/,
    );
    match(say.refusalFrom(mention, "   "), /^@suchipi did not approve it\.$/);
  });

  it("tells the agent that an answer comes back as a further turn", () => {
    match(say.systemPrompt("ask"), /reaches you as a further turn in this session/);
  });

  it("prefers the prompt over the raw text, and falls back when the prompt is empty", () => {
    strictEqual(say.spokenText(mention), "please fix the flaky test");
    strictEqual(
      say.spokenText({ ...mention, prompt: "" }),
      "@my-bot please fix the flaky test",
    );
  });

  it("tells the agent how waiting works, differently per approval mode", () => {
    match(say.systemPrompt("ask"), /waits there until somebody answers/);
    match(say.systemPrompt("allow"), /approved automatically/);
    match(say.systemPrompt("deny"), /refused automatically/);
  });

  it("gives the operator the last word in the system prompt", () => {
    const prompt = say.systemPrompt("ask", undefined, "  Work on a branch of your own.  ");
    match(prompt, /waits there until somebody answers/);
    ok(prompt.endsWith("\n\nWork on a branch of your own."), prompt);
  });

  it("tells the agent to write down a pull request it opens, and what to write", () => {
    const prompt = say.systemPrompt("ask", mention, "Work on a branch of your own.", {
      path: "/state/forks/forks.jsonl",
      from: "slack:T0:C0:1755973451.000100",
    });
    match(prompt, /append one line to \/state\/forks\/forks\.jsonl/);
    match(prompt, /\{"url": "<the pull request's url>", "from": "slack:T0:C0:1755973451\.000100"\}/);
    match(prompt, /starts as a fork of the session that recorded it/);
    // The operator still has the last word, however much this adds before it.
    ok(prompt.endsWith("\n\nWork on a branch of your own."), prompt);
  });

  it("says nothing about recording anything when there is nowhere to record it", () => {
    doesNotMatch(say.systemPrompt("ask", mention), /append one line/);
    doesNotMatch(say.systemPrompt("ask", mention), /pull request/);
  });

  it("opens a carried-over session by saying which thread it is now in", () => {
    const opening = say.carriedOverMessage(
      mention,
      "please fix the flaky test",
      "https://github.com/acme/widgets/pull/12",
    );
    match(opening, /^\[github:acme\/widgets#7\] Flaky test in CI\n/);
    match(opening, /This is a new thread, and it is not the one everything above came from\./);
    match(opening, /https:\/\/github\.com\/acme\/widgets\/pull\/12 came out of it/);
    match(opening, /nobody reading here saw the other one/);
    match(opening, /@suchipi said, via github issue_comment \(https:\S+\):\nplease fix the flaky test$/);
    // The framing belongs to a session that starts empty; this one starts with
    // the whole of another thread above it, framing included.
    doesNotMatch(opening, /posted back to that thread as a comment/);
  });

  it("adds nothing when the operator said nothing", () => {
    strictEqual(say.systemPrompt("ask", undefined, "   "), say.systemPrompt("ask"));
    strictEqual(say.systemPrompt("ask", undefined, undefined), say.systemPrompt("ask"));
  });

  it("puts the thread's link in the system prompt, with what to do about it", () => {
    const prompt = say.systemPrompt("ask", mention);
    match(prompt, /on github, at https:\/\/github\.com\/acme\/widgets\/issues\/7#issuecomment-100\./);
    match(prompt, /read the rest of it for context before you answer/);
  });

  it("leaves the platform out when the mention did not name one", () => {
    match(say.systemPrompt("ask", { ...mention, platform: "" }), /answering in is at https:\/\/github\.com/);
  });

  it("says nothing about the thread when the mention carried no link to it", () => {
    strictEqual(say.systemPrompt("ask", { ...mention, url: "" }), say.systemPrompt("ask"));
  });
});

describe("what the thread sees", () => {
  it("names the tool and shows its arguments on a permission request", () => {
    const notice = say.askNotice(ask({ description: "notes.txt" }));
    match(notice, /needs permission/);
    match(notice, /`Write` on notes\.txt/);
    match(notice, /file_path/);
    match(notice, /Reply `approve`/);
  });

  it("puts a shell command in the sentence, where Bash's summary would read as an object", () => {
    const notice = say.askNotice(
      ask({
        description: "List repo contents",
        tool: {
          name: "Bash",
          toolUseId: "t7",
          input: { command: "ls -la", description: "List repo contents" },
        },
      }),
    );
    match(notice, /run the shell command `ls -la` \(List repo contents\)\./);
    doesNotMatch(notice, /`Bash` on/);
  });

  it("still shows the Bash arguments the sentence leaves out", () => {
    const notice = say.askNotice(
      ask({
        tool: {
          name: "Bash",
          toolUseId: "t8",
          input: { command: "npm test", run_in_background: true },
        },
      }),
    );
    match(notice, /run the shell command `npm test`\./);
    match(notice, /run_in_background/);
    doesNotMatch(notice, /`\{"command"/);
  });

  it("lays a question out with its options", () => {
    const notice = say.askNotice(
      ask({
        isQuestion: true,
        tool: {
          name: "AskUserQuestion",
          toolUseId: "t2",
          input: {
            questions: [
              {
                question: "Tabs or spaces?",
                options: [
                  { label: "Tabs", description: "hard tabs" },
                  { label: "Spaces", description: "soft tabs" },
                ],
              },
            ],
          },
        },
      }),
    );
    match(notice, /has a question/);
    match(notice, /Tabs or spaces\?/);
    match(notice, /- `Tabs`: hard tabs/);
    match(notice, /Reply here with your answer/);
  });

  it("numbers several questions", () => {
    const notice = say.askNotice(
      ask({
        isQuestion: true,
        tool: {
          name: "AskUserQuestion",
          toolUseId: "t3",
          input: { questions: [{ question: "One?" }, { question: "Two?" }] },
        },
      }),
    );
    match(notice, /1\. One\?/);
    match(notice, /2\. Two\?/);
  });

  it("still says something useful when a question arrives without any", () => {
    const notice = say.askNotice(
      ask({
        isQuestion: true,
        tool: { name: "AskUserQuestion", toolUseId: "t4", input: {} },
      }),
    );
    match(notice, /only a person can give it/);
  });

  it("shows what a tool that stops for a person was called with", () => {
    const notice = say.askNotice(
      ask({
        isQuestion: true,
        description: "a worktree for ENG-1234",
        tool: {
          name: "EnterWorktree",
          toolUseId: "t7",
          input: { branch: "lily/eng-1234-thing" },
        },
      }),
    );
    match(notice, /`EnterWorktree` on a worktree for ENG-1234/);
    match(notice, /lily\/eng-1234-thing/);
    match(notice, /Reply here with your answer/);
  });

  it("collapses a long argument onto one line", () => {
    const notice = say.askNotice(
      ask({
        tool: {
          name: "Write",
          toolUseId: "t5",
          input: { content: "a\nb\n".repeat(400) },
        },
      }),
    );
    strictEqual(
      notice.split("\n").some((line) => line.length > 400),
      false,
    );
    match(notice, /\.\.\./);
  });

  it("lists what an unattended run refused to run", () => {
    const notice = say.denialNotice([
      { toolName: "Bash", toolUseId: "t6", input: { command: "rm -rf /" } },
    ]);
    match(notice, /stopped short of running/);
    match(notice, /`Bash`/);
  });

  it("tells the thread a mid-turn mention reached the running turn", () => {
    match(say.steeredNotice(mention), /already working/);
    match(say.steeredNotice(mention), /at its next step/);
  });

  it("points a steered comment at the thread the answer will appear in", () => {
    ok(say.steeredNotice(mention).includes(mention.url));
  });

  it("says a stopped turn was stopped, not that it failed", () => {
    match(say.interruptedNotice(), /Stopped, as asked\./);
    match(say.nothingToInterrupt(), /nothing to stop/);
  });

  it("says the process was ended, and whether a turn went with it", () => {
    match(say.exitedNotice(false), /Ended the Claude Code process\./);
    doesNotMatch(say.exitedNotice(false), /went with it/);
    match(say.exitedNotice(true), /turn it was running went with it/);
    match(say.exitedNotice(true), /keeps its history/);
    match(say.nothingToExit(), /nothing to end/);
  });

  it("confirms a settings change", () => {
    match(
      say.directiveNotice({ model: "opus" }, { model: "opus", effort: "high" }),
      /now on model `opus`\.$/,
    );
    match(
      say.directiveNotice(
        { model: "opus", effort: "max" },
        { model: "opus", effort: "max" },
      ),
      /model `opus` and effort `max`/,
    );
  });
});
