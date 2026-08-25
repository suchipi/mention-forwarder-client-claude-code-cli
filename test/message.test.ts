import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
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
    tool: { name: "Write", input: { file_path: "/repo/notes.txt", content: "hi" }, toolUseId: "t1" },
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
    match(opening, /from @suchipi via github issue_comment/);
    match(opening, /https:\/\/github\.com\/acme\/widgets\/issues\/7#issuecomment-100/);
    match(opening, /posted back to that thread as a comment/);
    match(opening, /please fix the flaky test$/);
  });

  it("leaves the framing out of every later message", () => {
    const later = say.followUpMessage(mention, "also update the changelog");
    doesNotMatch(later, /posted back to that thread as a comment/);
    match(later, /also update the changelog$/);
  });

  it("says something when the mention was only the trigger phrase", () => {
    match(say.followUpMessage(mention, ""), /no text beyond the trigger phrase/);
  });

  it("prefers the prompt over the raw text, and falls back when the prompt is empty", () => {
    strictEqual(say.spokenText(mention), "please fix the flaky test");
    strictEqual(say.spokenText({ ...mention, prompt: "" }), "@my-bot please fix the flaky test");
  });

  it("tells the agent how waiting works, differently per approval mode", () => {
    match(say.systemPrompt("ask"), /waits there until somebody answers/);
    match(say.systemPrompt("allow"), /approved automatically/);
    match(say.systemPrompt("deny"), /refused automatically/);
  });

  it("gives the operator the last word in the system prompt", () => {
    const prompt = say.systemPrompt("ask", "  Work on a branch of your own.  ");
    match(prompt, /waits there until somebody answers/);
    ok(prompt.endsWith("\n\nWork on a branch of your own."), prompt);
  });

  it("adds nothing when the operator said nothing", () => {
    strictEqual(say.systemPrompt("ask", "   "), say.systemPrompt("ask"));
    strictEqual(say.systemPrompt("ask", undefined), say.systemPrompt("ask"));
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
        tool: { name: "Bash", toolUseId: "t7", input: { command: "ls -la", description: "List repo contents" } },
      }),
    );
    match(notice, /run the shell command `ls -la` \(List repo contents\)\./);
    doesNotMatch(notice, /`Bash` on/);
  });

  it("still shows the Bash arguments the sentence leaves out", () => {
    const notice = say.askNotice(
      ask({ tool: { name: "Bash", toolUseId: "t8", input: { command: "npm test", run_in_background: true } } }),
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
              { question: "Tabs or spaces?", options: [{ label: "Tabs", description: "hard tabs" }, { label: "Spaces", description: "soft tabs" }] },
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
        tool: { name: "AskUserQuestion", toolUseId: "t3", input: { questions: [{ question: "One?" }, { question: "Two?" }] } },
      }),
    );
    match(notice, /1\. One\?/);
    match(notice, /2\. Two\?/);
  });

  it("still says something useful when a question arrives without any", () => {
    const notice = say.askNotice(ask({ isQuestion: true, tool: { name: "AskUserQuestion", toolUseId: "t4", input: {} } }));
    match(notice, /only a person can give it/);
  });

  it("collapses a long argument onto one line", () => {
    const notice = say.askNotice(ask({ tool: { name: "Write", toolUseId: "t5", input: { content: "a\nb\n".repeat(400) } } }));
    strictEqual(notice.split("\n").some((line) => line.length > 400), false);
    match(notice, /\.\.\./);
  });

  it("lists what an unattended run refused to run", () => {
    const notice = say.denialNotice([{ toolName: "Bash", toolUseId: "t6", input: { command: "rm -rf /" } }]);
    match(notice, /stopped short of running/);
    match(notice, /`Bash`/);
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
    match(say.directiveNotice({ model: "opus" }, { model: "opus", effort: "high" }), /now on model `opus`\.$/);
    match(say.directiveNotice({ model: "opus", effort: "max" }, { model: "opus", effort: "max" }), /model `opus` and effort `max`/);
  });
});
