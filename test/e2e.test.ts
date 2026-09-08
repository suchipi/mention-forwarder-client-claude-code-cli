import {
  deepStrictEqual,
  doesNotMatch,
  match,
  ok,
  strictEqual,
} from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(here, "..", "src", "cli.ts");
const stubPath = resolve(here, "stub-claude.mjs");

// Committed without an executable bit on some checkouts, and it has to run as argv[0].
chmodSync(stubPath, 0o755);

const workspaces: string[] = [];

function workspace(): string {
  const path = mkdtempSync(join(tmpdir(), "mfcc-test-"));
  workspaces.push(path);
  return path;
}

after(() => {
  for (const path of workspaces) rmSync(path, { recursive: true, force: true });
});

type Session = {
  send(prompt: string, id?: string, url?: string, kind?: string, raw?: unknown): string;
  waitFor(replyFile: string, contains?: string): Promise<string>;
  end(): Promise<{ code: number | null; log: string }>;
};

type StartOptions = {
  dir: string;
  scenario?: string;
  args?: string[];
  env?: Record<string, string>;
  conversationKey?: string;
};

function start({
  dir,
  scenario = "plain",
  args = [],
  env = {},
  conversationKey = "test:1",
}: StartOptions): Session {
  const child: ChildProcess = spawn(
    "node",
    [
      cliPath,
      "--binary",
      stubPath,
      "--cwd",
      dir,
      "--log-level",
      "debug",
      // Off unless a test asks for it, so a run cannot bind a port or publish
      // itself into the state directory of whoever is running the tests.
      "--web-port",
      "0",
      ...args,
    ],
    {
      cwd: resolve(here, ".."),
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        XDG_STATE_HOME: dir,
        CLAUDE_STUB_SCENARIO: scenario,
        ...env,
      },
    },
  );

  let log = "";
  child.stdout
    ?.setEncoding("utf8")
    .on("data", (chunk: string) => (log += chunk));
  child.stderr
    ?.setEncoding("utf8")
    .on("data", (chunk: string) => (log += chunk));

  let seq = 0;
  return {
    send(prompt, id, url, kind, raw) {
      seq += 1;
      const replyFile = join(dir, `reply-${id ?? seq}.md`);
      child.stdin?.write(
        `${JSON.stringify({
          id: id ?? `m${seq}`,
          conversationKey,
          replyFile,
          platform: "github",
          kind: kind ?? "issue_comment",
          url: url ?? `https://example.com/issues/1#c${seq}`,
          text: `@bot ${prompt}`,
          prompt,
          author: "suchipi",
          title: "A test issue",
          receivedAt: "2026-08-22T00:00:00.000Z",
          ...(raw === undefined ? {} : { raw }),
        })}\n`,
      );
      return replyFile;
    },

    async waitFor(replyFile, contains) {
      const deadline = Date.now() + 15000;
      for (;;) {
        if (existsSync(replyFile)) {
          const body = readFileSync(replyFile, "utf8");
          if (
            contains === undefined
              ? body.trim() !== ""
              : body.includes(contains)
          )
            return body;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for ${replyFile}${contains === undefined ? "" : ` to contain ${contains}`}\n${log}`,
          );
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    },

    end() {
      child.stdin?.end();
      return new Promise((done) =>
        child.once("close", (code) => done({ code, log })),
      );
    },
  };
}

describe("driving the claude CLI", () => {
  it("posts what the agent said, and tells it where it is", async () => {
    const dir = workspace();
    const transcript = join(dir, "transcript.txt");
    const session = start({
      dir,
      env: { CLAUDE_STUB_TRANSCRIPT: transcript },
      args: ["--no-state"],
    });

    const reply = session.send("please look at the flaky test");
    match(await session.waitFor(reply), /stub answered turn 1/);

    const { code } = await session.end();
    strictEqual(code, 0);

    const told = readFileSync(transcript, "utf8");
    match(told, /\[test:1\] A test issue/);
    match(told, /https:\/\/example\.com\/issues\/1#c1/);
    match(told, /posted back to that thread as a comment/);
    match(told, /@suchipi said, via github issue_comment \(https:\S+\):\nplease look at the flaky test/);
  });

  it("hands claude the operator's own instructions, after its own", async () => {
    const dir = workspace();
    const argvFile = join(dir, "argv.json");
    const session = start({
      dir,
      env: { CLAUDE_STUB_ARGV_FILE: argvFile },
      args: [
        "--no-state",
        "--append-system-prompt",
        "Work on a branch of your own.",
      ],
    });

    await session.waitFor(session.send("first"));
    await session.end();

    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    const prompt = argv[argv.indexOf("--append-system-prompt") + 1] ?? "";
    match(prompt, /posted back to the thread/);
    match(prompt, /on github, at https:\/\/example\.com\/issues\/1#c1\./);
    ok(prompt.endsWith("Work on a branch of your own."), prompt);
  });

  it("opens the session once and keeps it for later mentions", async () => {
    const dir = workspace();
    const transcript = join(dir, "transcript.txt");
    const session = start({
      dir,
      env: { CLAUDE_STUB_TRANSCRIPT: transcript },
      args: ["--no-state"],
    });

    await session.waitFor(session.send("first"));
    await session.waitFor(session.send("second"));
    await session.end();

    const turns = readFileSync(transcript, "utf8")
      .split("\n---\n")
      .filter((one) => one.trim() !== "");
    strictEqual(turns.length, 2);
    match(turns[0] ?? "", /posted back to that thread as a comment/);
    ok(
      !(turns[1] ?? "").includes("posted back to that thread as a comment"),
      "the second mention repeats the framing",
    );
    match(turns[1] ?? "", /second/);
  });

  it("posts a permission request and runs the tool once someone approves", async () => {
    const dir = workspace();
    const session = start({ dir, scenario: "ask", args: ["--no-state"] });

    const first = session.send("write the file");
    const asked = await session.waitFor(first, "needs permission");
    match(asked, /`Write`/);
    match(asked, /`approve`, `approved`, `allow`/);

    const second = session.send("approve");
    match(await session.waitFor(second), /stub wrote the file/);
    await session.end();
  });

  it("answers even when the CLI ran a prompt of its own first", async () => {
    const dir = workspace();
    const session = start({
      dir,
      env: { CLAUDE_STUB_QUEUED_NOTIFICATION: "1" },
      args: ["--no-state"],
    });

    const reply = session.send("please look at the flaky test");
    match(await session.waitFor(reply), /stub answered turn 1/);

    const { log } = await session.end();
    match(log, /ignored a turn end/);
    doesNotMatch(log, /a turn ended that this program did not start/);
  });

  it("still asks for permission when the CLI ran a prompt of its own first", async () => {
    const dir = workspace();
    const session = start({
      dir,
      scenario: "ask",
      env: { CLAUDE_STUB_QUEUED_NOTIFICATION: "1" },
      args: ["--no-state"],
    });

    const asked = await session.waitFor(
      session.send("write the file"),
      "needs permission",
    );
    match(asked, /`Write`/);

    match(await session.waitFor(session.send("approve")), /stub wrote the file/);
    await session.end();
  });

  it("lets a person approve a tool that wants a card of its own", async () => {
    const dir = workspace();
    const session = start({ dir, scenario: "card", args: ["--no-state"] });

    const asked = await session.waitFor(
      session.send("make me a worktree"),
      "needs permission",
    );
    match(asked, /`EnterWorktree` on a worktree for ENG-1234/);
    match(asked, /lily\/a-branch/);

    match(await session.waitFor(session.send("approve")), /stub made the worktree/);
    await session.end();
  });

  it("runs a tool that wants a card of its own under --approval allow", async () => {
    const dir = workspace();
    const session = start({
      dir,
      scenario: "card",
      args: ["--no-state", "--approval", "allow"],
    });

    match(await session.waitFor(session.send("make me a worktree")), /stub made the worktree/);
    await session.end();
  });

  it("stops a running turn when somebody says so in the thread", async () => {
    const dir = workspace();
    const session = start({ dir, scenario: "hang", args: ["--no-state"] });

    session.send("do something that never finishes");
    const stopped = session.send("[interrupt]");
    match(await session.waitFor(stopped, "Stopped"), /Stopped, as asked\./);
    await session.end();
  });

  it("runs what followed the interrupt as the next turn", async () => {
    const dir = workspace();
    const transcript = join(dir, "transcript.txt");
    const session = start({
      dir,
      scenario: "hang",
      env: { CLAUDE_STUB_TRANSCRIPT: transcript },
      args: ["--no-state"],
    });

    session.send("do something that never finishes");
    const stopped = session.send("[stop] do this instead");
    const body = await session.waitFor(stopped, "Stopped");
    match(body, /Stopped, as asked\./);
    // The stub only ever hangs on the first turn, so the second answers.
    match(await session.waitFor(stopped, "stub answered"), /do this instead/);
    await session.end();

    // The label goes on what is left of the mention, never in front of the
    // group: the other way round and the interrupt above never happens at all.
    const turns = readFileSync(transcript, "utf8")
      .split("\n---\n")
      .filter((one) => one.trim() !== "");
    strictEqual(turns.length, 2);
    match(turns[1] ?? "", /@suchipi said, via github issue_comment \(https:\S+\):\ndo this instead$/);
    doesNotMatch(turns[1] ?? "", /\[stop\]/);
  });

  it("stops a turn that is waiting on a permission request", async () => {
    const dir = workspace();
    const session = start({ dir, scenario: "ask", args: ["--no-state"] });

    await session.waitFor(session.send("write the file"), "needs permission");
    const stopped = session.send("[int]");
    const body = await session.waitFor(stopped, "Stopped");
    match(body, /Stopped, as asked\./);
    ok(
      !body.includes("no longer waiting on an answer"),
      "the withdrawn ask was narrated as well",
    );
    await session.end();
  });

  it("ends the claude process when somebody says so in the thread", async () => {
    const dir = workspace();
    const session = start({ dir, scenario: "hang", args: ["--no-state"] });

    session.send("do something that never finishes");
    const exited = await session.waitFor(
      session.send("[exit]"),
      "Ended the Claude Code process",
    );
    match(exited, /turn it was running went with it/);
    ok(
      !exited.includes("The turn failed"),
      "the process going away was reported as a failure",
    );
    await session.end();
  });

  it("ends a process whose turn is waiting on a permission request", async () => {
    const dir = workspace();
    const session = start({ dir, scenario: "ask", args: ["--no-state"] });

    await session.waitFor(session.send("write the file"), "needs permission");
    const exited = await session.waitFor(
      session.send("[exit]"),
      "Ended the Claude Code process",
    );
    match(exited, /turn it was running went with it/);
    ok(
      !exited.includes("no longer waiting on an answer"),
      "the ask that died with the process was narrated as well",
    );
    await session.end();
  });

  it("starts a new process on the same session for what followed the exit", async () => {
    const dir = workspace();
    const transcript = join(dir, "transcript.txt");
    const argvFile = join(dir, "argv.json");
    const session = start({
      dir,
      env: {
        CLAUDE_STUB_TRANSCRIPT: transcript,
        CLAUDE_STUB_ARGV_FILE: argvFile,
      },
      args: ["--no-state"],
    });

    await session.waitFor(session.send("first", "a"));
    const exited = session.send("[exit] do this instead", "b");
    await session.waitFor(exited, "Ended the Claude Code process");
    match(await session.waitFor(exited, "stub answered"), /do this instead/);
    await session.end();

    // The process that replaced it wrote over the first one's argv on its way up.
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    ok(
      argv.includes("--resume=11111111-2222-3333-4444-555555555555"),
      `expected a resume flag in ${JSON.stringify(argv)}`,
    );

    const turns = readFileSync(transcript, "utf8")
      .split("\n---\n")
      .filter((one) => one.trim() !== "");
    strictEqual(turns.length, 2);
    ok(
      !(turns[1] ?? "").includes("posted back to that thread as a comment"),
      "the replacement was told it was opening a session",
    );
  });

  it("says so when an exit arrives with no process to end", async () => {
    const dir = workspace();
    const session = start({ dir, scenario: "plain", args: ["--no-state"] });

    match(
      await session.waitFor(session.send("[quit]"), "nothing to end"),
      /Claude Code was not running/,
    );
    await session.end();
  });

  it("clears the thread's history and opens a new session for what follows", async () => {
    const dir = workspace();
    const stateFile = join(dir, "sessions.json");
    const transcript = join(dir, "transcript.txt");
    const argvFile = join(dir, "argv.json");
    const session = start({
      dir,
      args: ["--state-file", stateFile],
      env: {
        CLAUDE_STUB_TRANSCRIPT: transcript,
        CLAUDE_STUB_ARGV_FILE: argvFile,
      },
    });

    await session.waitFor(session.send("first", "a"));
    const cleared = session.send("[clear] start again", "b");
    await session.waitFor(cleared, "Cleared this thread's context");
    match(await session.waitFor(cleared, "stub answered"), /start again/);
    await session.end();

    // The process that replaced it opened a session rather than resuming one,
    // and was told so: this is the framing only a first message carries.
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    ok(
      !argv.some((arg) => arg.startsWith("--resume=")),
      `expected no resume in ${JSON.stringify(argv)}`,
    );
    const turns = readFileSync(transcript, "utf8")
      .split("\n---\n")
      .filter((one) => one.trim() !== "");
    strictEqual(turns.length, 2);
    ok(
      (turns[1] ?? "").includes("posted back to that thread as a comment"),
      "the session that replaced the cleared one was not told it was opening one",
    );

    // Remembered, so a later process does not hand the thread a history back.
    const remembered = JSON.parse(readFileSync(stateFile, "utf8")) as {
      conversations: Record<string, { cleared?: boolean }>;
    };
    strictEqual(remembered.conversations["test:1"]?.cleared, true);
  });

  it("says so when a clear finds no history", async () => {
    const dir = workspace();
    const session = start({ dir, args: ["--no-state"] });

    match(
      await session.waitFor(session.send("[clear]"), "no history here to clear"),
      /nothing has run in this thread yet/,
    );
    await session.end();
  });

  it("does not fork into a thread that has cleared its history", async () => {
    const dir = workspace();
    const stateFile = join(dir, "sessions.json");
    const forkFile = join(dir, "forks", "forks.jsonl");
    const argvFile = join(dir, "argv.json");

    const slack = start({
      dir,
      conversationKey: "slack:T0:C0:3.3",
      args: ["--state-file", stateFile],
    });
    await slack.waitFor(slack.send("open the pull request", "a"));
    await slack.end();

    // Written here by hand, because the agent is what writes it in a real run.
    writeFileSync(
      forkFile,
      `${JSON.stringify({ url: "https://github.com/acme/widgets/pull/13", from: "slack:T0:C0:3.3" })}\n`,
    );

    const github = start({
      dir,
      conversationKey: "github:acme/widgets#13",
      args: ["--state-file", stateFile],
      env: { CLAUDE_STUB_ARGV_FILE: argvFile },
    });
    // Cleared before the fork it had been given was ever opened, which is the
    // history this thread would have started with.
    const url = "https://github.com/acme/widgets/pull/13#issuecomment-9";
    await github.waitFor(github.send("[clear]", "b", url), "Cleared this thread's context");
    await github.waitFor(github.send("so what is this?", "c", url));
    const { log } = await github.end();

    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    ok(
      !argv.includes("--fork-session"),
      `expected no fork into a cleared thread in ${JSON.stringify(argv)}`,
    );
    ok(
      log.includes("not forking into a thread that has been cleared"),
      "the fork was skipped for some other reason than the clear",
    );
  });

  it("compacts the thread's history and says what became of it", async () => {
    const dir = workspace();
    const transcript = join(dir, "transcript.txt");
    const session = start({
      dir,
      args: ["--no-state"],
      env: { CLAUDE_STUB_TRANSCRIPT: transcript },
    });

    await session.waitFor(session.send("first", "a"));
    const compacted = session.send("[compact] now the tests", "b");
    await session.waitFor(compacted, "Compacted this thread's context");
    match(await session.waitFor(compacted, "29,169 tokens of it became 1,193"), /summary of itself/);
    match(await session.waitFor(compacted, "stub answered"), /now the tests/);
    await session.end();

    // Two turns, not three: the compaction itself is not one, and what followed
    // it ran on the other side of it.
    const turns = readFileSync(transcript, "utf8")
      .split("\n---\n")
      .filter((one) => one.trim() !== "");
    strictEqual(turns.length, 2);
    match(turns[1] ?? "", /now the tests/);
  });

  it("posts what claude said when it will not compact", async () => {
    const dir = workspace();
    const session = start({
      dir,
      args: ["--no-state"],
      env: { CLAUDE_STUB_COMPACT: "fail" },
    });

    await session.waitFor(session.send("first", "a"));
    match(
      await session.waitFor(session.send("[compact]", "b"), "could not compact"),
      /Not enough messages to compact/,
    );
    await session.end();
  });

  it("keeps a prompt the CLI queued for itself from ending a compaction", async () => {
    const dir = workspace();
    const session = start({
      dir,
      args: ["--no-state"],
      env: { CLAUDE_STUB_COMPACT: "queued" },
    });

    await session.waitFor(session.send("first", "a"));
    // The CLI answers what it had queued before it gets to the command, and that
    // answer must not be taken for the compaction's own end: the compaction has
    // not run yet, and the turn holding its place is what it reports to.
    const compacted = session.send("[compact] and then this", "b");
    await session.waitFor(compacted, "stub answered a prompt it had queued");
    await session.waitFor(compacted, "Compacted this thread's context");
    match(await session.waitFor(compacted, "stub answered turn"), /and then this/);
    await session.end();
  });

  it("says so when a compaction finds no history", async () => {
    const dir = workspace();
    const session = start({ dir, args: ["--no-state"] });

    match(
      await session.waitFor(session.send("[compact]"), "no history here to compact"),
      /nothing has run in this thread yet/,
    );
    await session.end();
  });

  it("waits for the running turn before compacting what it is still writing", async () => {
    const dir = workspace();
    const transcript = join(dir, "transcript.txt");
    const session = start({
      dir,
      scenario: "steer",
      args: ["--no-state"],
      env: { CLAUDE_STUB_TRANSCRIPT: transcript },
    });

    // Never steers, so turn 1 answers on the stub's backstop and this follows it.
    const first = session.send("first", "a");
    const compacted = session.send("[compact]", "b");
    match(await session.waitFor(first, "stub answered"), /turn 1: first/);
    await session.waitFor(compacted, "Compacted this thread's context");
    await session.end();

    const turns = readFileSync(transcript, "utf8")
      .split("\n---\n")
      .filter((one) => one.trim() !== "");
    strictEqual(turns.length, 1);
  });

  it("says so when an interrupt arrives with nothing to stop", async () => {
    const dir = workspace();
    const session = start({ dir, scenario: "plain", args: ["--no-state"] });

    match(
      await session.waitFor(session.send("[stop]"), "nothing to stop"),
      /Nothing was running/,
    );
    await session.end();
  });

  it("gives the agent the refusal a person wrote", async () => {
    const dir = workspace();
    const session = start({ dir, scenario: "ask", args: ["--no-state"] });

    await session.waitFor(session.send("write the file"), "needs permission");
    const second = session.send("no, that file is generated");
    match(
      await session.waitFor(second),
      /stub was told: @suchipi refused it, in the thread: no, that file is generated/,
    );
    await session.end();
  });

  it("posts a question with its options and passes the answer back", async () => {
    const dir = workspace();
    const session = start({ dir, scenario: "question", args: ["--no-state"] });

    const asked = await session.waitFor(
      session.send("ask me something"),
      "has a question",
    );
    match(asked, /Tabs or spaces\?/);
    match(asked, /- `Tabs`: hard tabs/);

    const second = session.send("spaces");
    match(
      await session.waitFor(second),
      /@suchipi answered, in the thread: spaces/,
    );
    await session.end();
  });

  it("approves everything under --approval allow", async () => {
    const dir = workspace();
    const session = start({
      dir,
      scenario: "ask",
      args: ["--no-state", "--approval", "allow"],
    });

    const reply = session.send("write the file");
    match(await session.waitFor(reply), /stub wrote the file/);
    await session.end();
  });

  it("still waits on a question under --approval allow", async () => {
    const dir = workspace();
    const session = start({
      dir,
      scenario: "question",
      args: ["--no-state", "--approval", "allow"],
    });

    match(
      await session.waitFor(session.send("ask me something"), "has a question"),
      /Tabs or spaces\?/,
    );
    const second = session.send("spaces");
    match(
      await session.waitFor(second),
      /@suchipi answered, in the thread: spaces/,
    );
    await session.end();
  });

  it("refuses a question under --approval deny", async () => {
    const dir = workspace();
    const session = start({
      dir,
      scenario: "question",
      args: ["--no-state", "--approval", "deny"],
    });

    const reply = session.send("ask me something");
    match(await session.waitFor(reply), /nobody at a keyboard to answer that/);
    await session.end();
  });

  it("refuses everything under --approval deny, and says what it skipped", async () => {
    const dir = workspace();
    const session = start({
      dir,
      scenario: "ask",
      args: ["--no-state", "--approval", "deny"],
    });

    const reply = session.send("write the file");
    const body = await session.waitFor(reply, "stopped short of running");
    match(body, /`Write`/);
    await session.end();
  });

  it("steers a mention that arrives mid-turn into the turn already running", async () => {
    const dir = workspace();
    const transcript = join(dir, "transcript.txt");
    const steers = join(dir, "steers.txt");
    const session = start({
      dir,
      scenario: "steer",
      env: { CLAUDE_STUB_TRANSCRIPT: transcript, CLAUDE_STUB_STEERS: steers },
      args: ["--no-state"],
    });

    // Two review comments in two review threads, which GitHub answers in two
    // places: the case the notice exists for. The stub holds turn 1's answer
    // until it is steered, so nothing here races it.
    const first = session.send(
      "first",
      "a",
      "https://example.com/pull/1#discussion_r1",
      "pull_request_review_comment",
      { comment: { id: 1 } },
    );
    const second = session.send(
      "second",
      "b",
      "https://example.com/pull/1#discussion_r2",
      "pull_request_review_comment",
      { comment: { id: 2 } },
    );

    // Told to the comment that steered it, since nothing else says it landed,
    // and offered the group that would have had it answered on its own.
    const notice = await session.waitFor(second, "already working");
    match(notice, /picked this up as part of that/);
    match(notice, /discussion_r1/);
    match(notice, /with `\[fork\]`/);

    // The answer belongs to the comment that started the turn, not the one that
    // steered it: on GitHub those are two different review threads.
    match(await session.waitFor(first, "stub answered"), /steered: second/);
    await session.end();

    // One turn, not two: the second mention joined the first rather than following it.
    const turns = readFileSync(transcript, "utf8")
      .split("\n---\n")
      .filter((one) => one.trim() !== "");
    strictEqual(turns.length, 1);
    match(turns[0] ?? "", /first/);

    // A steer is told it is one, so the agent reads it as a change of course.
    const landed = readFileSync(steers, "utf8");
    match(landed, /while you were still working/);
    match(
      landed,
      /@suchipi said, via github pull_request_review_comment \(https:\S+\):\nsecond$/m,
    );

    // Read once the session is over, when nothing further can be written: the
    // steering comment got the notice and never the answer.
    const steererReply = readFileSync(second, "utf8");
    doesNotMatch(steererReply, /stub answered/);
    match(steererReply, /already working/);
  });

  it("says nothing to a steer already in the thread the answer is coming to", async () => {
    const dir = workspace();
    const session = start({ dir, scenario: "steer", args: ["--no-state"] });

    // Issue comments on the one issue, which are answered on that issue, so the
    // answer to this turn lands where a notice would have pointed anyway.
    const first = session.send("first");
    const second = session.send("second");

    // The answer naming what was steered into it is what says the steer landed.
    match(await session.waitFor(first, "stub answered"), /steered: second/);
    await session.end();

    const steererReply = existsSync(second) ? readFileSync(second, "utf8") : "";
    strictEqual(steererReply.trim(), "");
  });

  it("says nothing to a steer written in the review thread the answer lands in", async () => {
    const dir = workspace();
    const session = start({ dir, scenario: "steer", args: ["--no-state"] });

    // A reply in the thread the turn started in: GitHub answers the comment that
    // started it by replying in that same thread, which this comment is reading.
    const first = session.send(
      "first",
      "a",
      "https://example.com/pull/1#discussion_r1",
      "pull_request_review_comment",
      { comment: { id: 1 } },
    );
    const second = session.send(
      "second",
      "b",
      "https://example.com/pull/1#discussion_r2",
      "pull_request_review_comment",
      { comment: { id: 2, in_reply_to_id: 1 } },
    );

    match(await session.waitFor(first, "stub answered"), /steered: second/);
    await session.end();

    const steererReply = existsSync(second) ? readFileSync(second, "utf8") : "";
    strictEqual(steererReply.trim(), "");
  });

  it("queues a mention that changes the model rather than steering with it", async () => {
    const dir = workspace();
    const transcript = join(dir, "transcript.txt");
    const argvFile = join(dir, "argv.json");
    const session = start({
      dir,
      scenario: "steer",
      env: {
        CLAUDE_STUB_TRANSCRIPT: transcript,
        CLAUDE_STUB_ARGV_FILE: argvFile,
      },
      args: ["--no-state"],
    });

    // Never steers, so turn 1 answers on the stub's backstop and this one follows it.
    const first = session.send("first", "a");
    const second = session.send("[model=opus] second", "b");
    match(await session.waitFor(first, "stub answered"), /turn 1: first/);
    match(await session.waitFor(second, "stub answered"), /second/);
    await session.end();

    // Two turns: a start-up flag cannot be folded into a turn already running.
    const turns = readFileSync(transcript, "utf8")
      .split("\n---\n")
      .filter((one) => one.trim() !== "");
    strictEqual(turns.length, 2);
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    ok(
      argv.includes("opus"),
      `expected the new model in ${JSON.stringify(argv)}`,
    );
  });

  it("answers a waiting request with the next mention, not with a new turn", async () => {
    const dir = workspace();
    const transcript = join(dir, "transcript.txt");
    const session = start({
      dir,
      scenario: "ask",
      env: { CLAUDE_STUB_TRANSCRIPT: transcript },
      args: ["--no-state"],
    });

    await session.waitFor(session.send("write the file"), "needs permission");
    await session.waitFor(session.send("approve"), "stub wrote the file");
    await session.end();

    // One turn, not two: the approval was a decision, not another thing to run.
    const turns = readFileSync(transcript, "utf8")
      .split("\n---\n")
      .filter((one) => one.trim() !== "");
    strictEqual(turns.length, 1);
  });

  it("says so in the thread when claude will not start", async () => {
    const dir = workspace();
    const session = start({ dir, scenario: "crash", args: ["--no-state"] });

    const reply = session.send("hello");
    match(await session.waitFor(reply), /could not start Claude Code/);
    await session.end();
  });

  it("remembers the session and resumes it in the next process", async () => {
    const dir = workspace();
    const stateFile = join(dir, "sessions.json");
    const argvFile = join(dir, "argv.json");

    const first = start({ dir, args: ["--state-file", stateFile] });
    await first.waitFor(first.send("first", "a"));
    await first.end();

    const remembered = JSON.parse(readFileSync(stateFile, "utf8")) as {
      conversations: Record<string, { sessionId: string; cwd: string }>;
    };
    const entry = remembered.conversations["test:1"];
    strictEqual(entry?.sessionId, "11111111-2222-3333-4444-555555555555");
    strictEqual(entry?.cwd, resolve(dir));

    const second = start({
      dir,
      args: ["--state-file", stateFile],
      env: { CLAUDE_STUB_ARGV_FILE: argvFile },
    });
    await second.waitFor(second.send("second", "b"));
    await second.end();

    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    ok(
      argv.includes(`--resume=${entry.sessionId}`),
      `expected a resume flag in ${JSON.stringify(argv)}`,
    );
  });

  it("starts a thread that came out of another one as a fork of its session", async () => {
    const dir = workspace();
    const stateFile = join(dir, "sessions.json");
    const forkFile = join(dir, "forks", "forks.jsonl");
    const argvFile = join(dir, "argv.json");
    const transcript = join(dir, "transcript.txt");

    const slack = start({
      dir,
      conversationKey: "slack:T0:C0:1.1",
      args: ["--state-file", stateFile],
      env: { CLAUDE_STUB_ARGV_FILE: argvFile },
    });
    await slack.waitFor(slack.send("fix the flaky test", "a"));
    await slack.end();

    // The agent's half of this: it is asked for the line, and given a directory
    // it may write in so that writing it is not a permission request.
    const asked = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    const prompt = asked[asked.indexOf("--append-system-prompt") + 1] ?? "";
    ok(prompt.includes(`append one line to ${forkFile}`), prompt);
    ok(prompt.includes('"from": "slack:T0:C0:1.1"'), prompt);
    strictEqual(asked[asked.indexOf("--add-dir") + 1], dirname(forkFile));

    // Written here by hand, because the agent is what writes it in a real run.
    writeFileSync(
      forkFile,
      `${JSON.stringify({ url: "https://github.com/acme/widgets/pull/12", from: "slack:T0:C0:1.1" })}\n`,
    );

    const github = start({
      dir,
      conversationKey: "github:acme/widgets#12",
      args: ["--state-file", stateFile],
      env: { CLAUDE_STUB_ARGV_FILE: argvFile, CLAUDE_STUB_TRANSCRIPT: transcript },
    });
    await github.waitFor(
      github.send(
        "what did you change here?",
        "b",
        "https://github.com/acme/widgets/pull/12#issuecomment-9",
      ),
    );
    await github.end();

    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    ok(
      argv.includes("--resume=11111111-2222-3333-4444-555555555555"),
      `expected the other thread's session in ${JSON.stringify(argv)}`,
    );
    ok(argv.includes("--fork-session"), `expected a fork in ${JSON.stringify(argv)}`);

    // The thread it was forked from is still live, in this same directory, and
    // the worktree in the history it copied is that thread's rather than this one's.
    const forkedPrompt = argv[argv.indexOf("--append-system-prompt") + 1] ?? "";
    match(forkedPrompt, /forked from another thread's, which is still live/);
    match(forkedPrompt, /Any worktree or branch named above belongs to that thread/);

    // Everything above this message happened in the other thread, so the message
    // says which thread this is instead of carrying on as though it were that one.
    const told = readFileSync(transcript, "utf8");
    match(told, /^\[github:acme\/widgets#12\] A test issue\n/);
    match(told, /This is a new thread/);
    match(told, /https:\/\/github\.com\/acme\/widgets\/pull\/12 came out of it/);

    // A session each: the fork was filed under the thread that forked it, and the
    // thread it came out of still has the session it had.
    const remembered = JSON.parse(readFileSync(stateFile, "utf8")) as {
      conversations: Record<string, { sessionId: string }>;
    };
    strictEqual(
      remembered.conversations["slack:T0:C0:1.1"]?.sessionId,
      "11111111-2222-3333-4444-555555555555",
    );
    strictEqual(
      remembered.conversations["github:acme/widgets#12"]?.sessionId,
      "99999999-8888-7777-6666-555555555555",
    );
  });

  it("gives a forked thread the model and effort of the thread it came from", async () => {
    const dir = workspace();
    const stateFile = join(dir, "sessions.json");
    const forkFile = join(dir, "forks", "forks.jsonl");
    const argvFile = join(dir, "argv.json");

    const slack = start({
      dir,
      conversationKey: "slack:T0:C0:2.2",
      args: ["--state-file", stateFile],
    });
    await slack.waitFor(slack.send("[model=opus, effort=max] fix the flaky test", "a"));
    await slack.end();

    writeFileSync(
      forkFile,
      `${JSON.stringify({ url: "https://github.com/acme/widgets/pull/13", from: "slack:T0:C0:2.2" })}\n`,
    );

    // Started with neither of its own, so whatever is in its argv came across
    // with the history: the pull request is answered by what did the work.
    const github = start({
      dir,
      conversationKey: "github:acme/widgets#13",
      args: ["--state-file", stateFile],
      env: { CLAUDE_STUB_ARGV_FILE: argvFile },
    });
    await github.waitFor(
      github.send(
        "what did you change here?",
        "b",
        "https://github.com/acme/widgets/pull/13#issuecomment-1",
      ),
    );
    await github.end();

    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    strictEqual(argv[argv.indexOf("--model") + 1], "opus", JSON.stringify(argv));
    strictEqual(argv[argv.indexOf("--effort") + 1], "max", JSON.stringify(argv));

    // Kept under the forked thread's own key, so the process after this starts on them too.
    const remembered = JSON.parse(readFileSync(stateFile, "utf8")) as {
      conversations: Record<string, { settings?: { model?: string; effort?: string } }>;
    };
    strictEqual(remembered.conversations["github:acme/widgets#13"]?.settings?.model, "opus");
    strictEqual(remembered.conversations["github:acme/widgets#13"]?.settings?.effort, "max");
  });

  it("keeps a setting the forked thread had already made its own", async () => {
    const dir = workspace();
    const stateFile = join(dir, "sessions.json");
    const forkFile = join(dir, "forks", "forks.jsonl");
    const argvFile = join(dir, "argv.json");

    const slack = start({
      dir,
      conversationKey: "slack:T0:C0:3.3",
      args: ["--state-file", stateFile],
    });
    await slack.waitFor(slack.send("[model=opus, effort=max] fix the flaky test", "a"));
    await slack.end();

    writeFileSync(
      forkFile,
      `${JSON.stringify({ url: "https://github.com/acme/widgets/pull/14", from: "slack:T0:C0:3.3" })}\n`,
    );

    // A group on its own settles this thread's effort and runs nothing at all.
    const settling = start({
      dir,
      conversationKey: "github:acme/widgets#14",
      args: ["--state-file", stateFile],
    });
    await settling.waitFor(
      settling.send("[effort=low]", "b", "https://github.com/acme/widgets/pull/14#issuecomment-1"),
      "effort `low`",
    );
    await settling.end();

    // The session it borrowed to fork from is not written down as its own: read
    // back, it would be resumed rather than forked, and two threads would share it.
    const between = JSON.parse(readFileSync(stateFile, "utf8")) as {
      conversations: Record<string, { sessionId?: string; settings?: { effort?: string } }>;
    };
    strictEqual(between.conversations["github:acme/widgets#14"]?.sessionId, undefined);
    strictEqual(between.conversations["github:acme/widgets#14"]?.settings?.effort, "low");

    const github = start({
      dir,
      conversationKey: "github:acme/widgets#14",
      args: ["--state-file", stateFile],
      env: { CLAUDE_STUB_ARGV_FILE: argvFile },
    });
    await github.waitFor(
      github.send(
        "what did you change here?",
        "c",
        "https://github.com/acme/widgets/pull/14#issuecomment-2",
      ),
    );
    await github.end();

    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    ok(argv.includes("--fork-session"), `expected a fork in ${JSON.stringify(argv)}`);
    strictEqual(argv[argv.indexOf("--model") + 1], "opus", JSON.stringify(argv));
    strictEqual(argv[argv.indexOf("--effort") + 1], "low", JSON.stringify(argv));
  });

  it("remembers a setting from a group that ran no turn", async () => {
    const dir = workspace();
    const stateFile = join(dir, "sessions.json");
    const argvFile = join(dir, "argv.json");

    // A group on its own is answered without starting the agent, so this is the
    // one way a thread's settings change while it still has no session id.
    const first = start({ dir, args: ["--state-file", stateFile] });
    await first.waitFor(first.send("[effort=max]", "a"), "effort `max`");
    await first.end();

    const second = start({
      dir,
      args: ["--state-file", stateFile],
      env: { CLAUDE_STUB_ARGV_FILE: argvFile },
    });
    await second.waitFor(second.send("hello", "b"));
    await second.end();

    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    strictEqual(
      argv[argv.indexOf("--effort") + 1],
      "max",
      `expected the remembered effort in ${JSON.stringify(argv)}`,
    );
  });

  it("passes the flags claude needs to speak this protocol", async () => {
    const dir = workspace();
    const argvFile = join(dir, "argv.json");
    const session = start({
      dir,
      args: [
        "--no-state",
        "--model",
        "opus",
        "--effort",
        "high",
        "--permission-mode",
        "acceptEdits",
        "--claude-arg=--fallback-model=sonnet",
      ],
      env: { CLAUDE_STUB_ARGV_FILE: argvFile },
    });
    await session.waitFor(session.send("hello"));
    await session.end();

    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    deepStrictEqual(argv.slice(0, 8), [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-prompt-tool",
      "stdio",
    ]);
    ok(argv.includes("--model") && argv.includes("opus"));
    ok(argv.includes("--effort") && argv.includes("high"));
    ok(argv.includes("--permission-mode") && argv.includes("acceptEdits"));
    strictEqual(argv.at(-1), "--fallback-model=sonnet");
  });

  it("folds a setting that is not a start-up flag into the turn already running", async () => {
    const dir = workspace();
    const transcript = join(dir, "transcript.txt");
    const session = start({
      dir,
      scenario: "steer",
      env: { CLAUDE_STUB_TRANSCRIPT: transcript },
      args: ["--no-state", "--progress", "final"],
    });

    const first = session.send("first", "a");
    const second = session.send("[progress=all] second", "b");

    // Said to the comment that wrote it, while the turn it was written into carries on.
    match(await session.waitFor(second, "now on progress"), /progress `all`/);
    match(await session.waitFor(first, "stub answered"), /steered: second/);
    await session.end();

    // One turn, not two: `progress` is this program's own doing rather than a
    // flag `claude` was started with, so nothing had to be restarted for it.
    const turns = readFileSync(transcript, "utf8")
      .split("\n---\n")
      .filter((one) => one.trim() !== "");
    strictEqual(turns.length, 1);
  });

  it("refuses a setting the whole process is on rather than quietly ignoring it", async () => {
    const dir = workspace();
    const session = start({ dir, args: ["--no-state"] });
    const reply = session.send("[logLevel=debug] have a look");
    const body = await session.waitFor(reply, "settled for this whole process");
    match(body, /`logLevel`/);
    // Nothing ran: the mention is answered by the refusal and not by the agent.
    doesNotMatch(body, /stub answered/);
    await session.end();
  });

  it("posts only the answer under --progress final", async () => {
    const dir = workspace();
    const session = start({ dir, args: ["--no-state", "--progress", "final"] });
    const reply = session.send("hello");
    match(await session.waitFor(reply), /stub answered turn 1/);
    await session.end();
  });

  it("posts a permission request, and what led to it, under --progress final", async () => {
    const dir = workspace();
    const session = start({
      dir,
      scenario: "ask",
      args: ["--no-state", "--progress", "final"],
    });

    const asked = await session.waitFor(
      session.send("write the file"),
      "needs permission",
    );
    match(asked, /stub is about to write notes\.txt/);
    match(asked, /`Write`/);
    match(asked, /`approve`, `approved`, `allow`/);

    // The turn's own answer still arrives, and only once: letting the prose out
    // early must not spend the end-of-turn post that `final` relies on.
    const answered = await session.waitFor(session.send("approve"));
    strictEqual(answered.match(/stub wrote the file/g)?.length, 1);
    await session.end();
  });

  it("records raw events when asked to", async () => {
    const dir = workspace();
    const record = join(dir, "events.jsonl");
    const session = start({ dir, args: ["--no-state", "--record", record] });
    await session.waitFor(session.send("hello"));
    await session.end();

    const lines = readFileSync(record, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    ok(lines.some((event) => event.type === "system"));
    ok(lines.some((event) => event.type === "result"));
  });

  it("lists itself, and the thread it came from, on the web view", async () => {
    const dir = workspace();
    const port = await freePort();
    const session = start({
      dir,
      args: ["--no-state", "--web-port", String(port)],
    });

    try {
      await session.waitFor(session.send("hello"));

      const one = await waitForConversation(port);
      strictEqual(one.conversationKey, "test:1");
      strictEqual(one.thread?.title, "A test issue");
      strictEqual(one.thread?.url, "https://example.com/issues/1#c1");
      strictEqual(one.thread?.platform, "github");
      strictEqual(one.cwd, dir);
      strictEqual(one.state, "idle");
      strictEqual(one.mentions, 1);

      const page = await fetch(`http://127.0.0.1:${port}/`);
      match(await page.text(), /Running conversations/);
    } finally {
      await session.end();
    }

    // The entry goes with the process, so a view of it never lists a thread
    // nothing is working on.
    deepStrictEqual(
      readdirSync(join(dir, "mention-forwarder-claude-code", "live")),
      [],
    );
  });
});

describe("forking a review thread", () => {
  /** A review comment payload, cut down to what places the comment in its thread. */
  const inThread = (id: number, root?: number) => ({
    comment: { id, ...(root === undefined ? {} : { in_reply_to_id: root }) },
  });
  const at = (id: number) => `https://github.com/acme/widgets/pull/7#discussion_r${id}`;
  const review = "pull_request_review_comment";

  function onPullRequest(dir: string, args: string[], env: Record<string, string> = {}, scenario?: string) {
    return start({ dir, conversationKey: "github:acme/widgets#7", args, env, scenario });
  }

  function conversations(stateFile: string): Record<string, { sessionId?: string; cwd?: string }> {
    return (JSON.parse(readFileSync(stateFile, "utf8")) as {
      conversations: Record<string, { sessionId?: string; cwd?: string }>;
    }).conversations;
  }

  it("gives the thread a session of its own, forked off the pull request's", async () => {
    const dir = workspace();
    const stateFile = join(dir, "sessions.json");
    const transcript = join(dir, "transcript.txt");
    const argvFile = join(dir, "argv.json");
    const session = onPullRequest(dir, ["--state-file", stateFile], {
      CLAUDE_STUB_TRANSCRIPT: transcript,
      CLAUDE_STUB_ARGV_FILE: argvFile,
    });

    await session.waitFor(session.send("what is this doing?", "a"));

    const forked = session.send("[fork] work out whether it breaks the importer", "b", at(200), review, inThread(200));
    // The fork says nothing for itself: what comes back is the answer to what
    // followed the group, with nothing on top of it.
    match(await session.waitFor(forked, "stub answered"), /^stub answered turn 1/);

    // Every later comment in that thread is answered by the session it made,
    // rather than going back to the one the pull request is on.
    const later = session.send("and the exporter?", "c", at(201), review, inThread(201, 200));
    match(await session.waitFor(later), /stub answered turn 2/);
    await session.end();

    // A session each, the fork's under a key of its own beneath the pull request's.
    const remembered = conversations(stateFile);
    strictEqual(remembered["github:acme/widgets#7"]?.sessionId, "11111111-2222-3333-4444-555555555555");
    strictEqual(
      remembered["github:acme/widgets#7#review:200"]?.sessionId,
      "99999999-8888-7777-6666-555555555555",
    );

    // The forked thread's own claude started last, so this is its argv: it was
    // told that the pull request's agent is working in the same directory.
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    ok(argv.includes("--fork-session"), `expected the fork's argv in ${JSON.stringify(argv)}`);
    match(
      argv[argv.indexOf("--append-system-prompt") + 1] ?? "",
      /forked from another thread's, which is still live/,
    );

    // Everything above the forked session's first message was said to the pull
    // request, so that message says which thread this now is.
    const told = readFileSync(transcript, "utf8");
    match(told, /\[github:acme\/widgets#7#review:200\] A test issue/);
    match(told, /This is one review thread on the pull request everything above was said on/);
  });

  it("answers a forked thread while the pull request's own turn is still waiting", async () => {
    const dir = workspace();
    const stateFile = join(dir, "sessions.json");
    const session = onPullRequest(dir, ["--state-file", stateFile], {}, "ask");

    const onThePullRequest = session.send("write the file", "a");
    await session.waitFor(onThePullRequest, "needs permission");

    // Read rather than taken as the answer to what the pull request is waiting
    // on, and answered by a claude of its own while that goes on waiting.
    const forked = session.send("[fork] and here too", "b", at(200), review, inThread(200));
    const asked = await session.waitFor(forked, "needs permission");
    match(asked, /^stub is about to write/);

    const answered = session.send("approve", "c", at(201), review, inThread(201, 200));
    match(await session.waitFor(answered), /stub wrote the file/);

    const stillWaiting = readFileSync(onThePullRequest, "utf8");
    ok(
      !stillWaiting.includes("stub wrote the file"),
      `the pull request's own turn was answered by the fork's reply: ${stillWaiting}`,
    );
    await session.end();
  });

  it("makes the thread without a word, and will not make it twice", async () => {
    const dir = workspace();
    const stateFile = join(dir, "sessions.json");
    const session = onPullRequest(dir, ["--state-file", stateFile]);

    await session.waitFor(session.send("what is this doing?", "a"));

    // A group on its own runs no turn, and the fork does not announce itself, so
    // this comment is answered with no comment at all.
    const alone = session.send("[fork]", "b", at(200), review, inThread(200));

    const asked = session.send("go on then", "c", at(201), review, inThread(201, 200));
    match(await session.waitFor(asked), /stub answered turn 1/);

    const again = session.send("[fork] again", "d", at(202), review, inThread(202, 200));
    const refused = await session.waitFor(again);
    match(refused, /already has a session of its own/);
    ok(!refused.includes("stub answered"), `the second fork ran a turn: ${refused}`);
    await session.end();

    // Read once the session is over, when nothing further can be written to it.
    const silent = existsSync(alone) ? readFileSync(alone, "utf8") : "";
    strictEqual(silent.trim(), "");
  });

  it("says so when there was no session to copy into the new thread", async () => {
    const dir = workspace();
    const session = onPullRequest(dir, ["--no-state"]);

    // Nothing has run on the pull request, so the thread this splits has no
    // session behind it and the new one starts blank: the one fork worth a word.
    const forked = session.send("[fork] have a look", "a", at(200), review, inThread(200));
    const said = await session.waitFor(forked, "nothing to copy");
    match(said, /no session to fork/);

    // Made all the same, and answering in the thread from here.
    match(await session.waitFor(forked, "stub answered"), /stub answered turn 1/);
    await session.end();
  });

  it("says there is nothing to fork where there is no review thread to fork", async () => {
    const dir = workspace();
    const session = onPullRequest(dir, ["--no-state"]);

    const elsewhere = session.send("[fork] have a look", "a");
    match(await session.waitFor(elsewhere), /only means something written in a review comment/);

    // A review comment with no payload behind it cannot be placed in a thread,
    // and a fork that could not be followed is worse than none.
    const unplaceable = session.send("[fork] have a look", "b", at(200), review);
    const said = await session.waitFor(unplaceable);
    match(said, /cannot tell which review thread this comment is in/);
    match(said, /includeRawPayload/);
    await session.end();
  });

  it("sends a forked thread's later mentions to its own session in the next process", async () => {
    const dir = workspace();
    const stateFile = join(dir, "sessions.json");
    const argvFile = join(dir, "argv.json");

    const first = onPullRequest(dir, ["--state-file", stateFile]);
    await first.waitFor(first.send("what is this doing?", "a"));
    await first.waitFor(
      first.send("[fork] look at this", "b", at(200), review, inThread(200)),
      "stub answered",
    );
    await first.end();

    const second = onPullRequest(dir, ["--state-file", stateFile], { CLAUDE_STUB_ARGV_FILE: argvFile });
    await second.waitFor(second.send("and now?", "c", at(201), review, inThread(201, 200)));
    await second.end();

    // Only the forked thread ran in that process, so this is its child: it
    // carried on the session the fork left behind rather than forking again.
    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    ok(
      argv.includes("--resume=99999999-8888-7777-6666-555555555555"),
      `expected the forked thread's own session in ${JSON.stringify(argv)}`,
    );
    ok(!argv.includes("--fork-session"), `expected a resume rather than a fork in ${JSON.stringify(argv)}`);

    // The copying is over and the sharing is not, so this run is told as well.
    match(
      argv[argv.indexOf("--append-system-prompt") + 1] ?? "",
      /Any worktree or branch named above belongs to that thread/,
    );
  });
});

describe("serving the web view on its own", () => {
  it("stays up with no mentions at all, and lists what a conversation publishes", async () => {
    const dir = workspace();
    const port = await freePort();
    const viewer = spawn("node", [cliPath, "--web-port", String(port), "--web-only"], {
      cwd: resolve(here, ".."),
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, XDG_STATE_HOME: dir },
    });

    try {
      // Nothing is running, which is the answer a person opening it wants.
      const empty = await waitForJson(port);
      deepStrictEqual(empty.conversations, []);

      // A conversation finds the port taken and publishes anyway; the viewer lists it.
      const session = start({
        dir,
        args: ["--no-state", "--web-port", String(port)],
      });
      await session.waitFor(session.send("hello"));
      const one = await waitForConversation(port);
      strictEqual(one.conversationKey, "test:1");
      await session.end();

      // And it outlives that conversation rather than going with it.
      const after = await waitForJson(port);
      ok(Array.isArray(after.conversations), "the viewer stopped answering");
    } finally {
      viewer.kill("SIGTERM");
      await once(viewer, "close");
    }
  });
});

/** A port nothing is listening on, taken and given straight back. */
async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  ok(address !== null && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

type Listed = {
  conversationKey: string;
  cwd: string;
  state: string;
  mentions: number;
  turns: number;
  thread?: { platform: string; title: string; url: string };
};

/** Answers once the view is up, whatever it has in it. */
async function waitForJson(port: number): Promise<{ conversations: Listed[] }> {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/conversations.json`);
      return (await response.json()) as { conversations: Listed[] };
    } catch {
      if (Date.now() > deadline) throw new Error("the web view never came up");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

/** The view is published on a timer, so the first fetch can beat the first entry. */
async function waitForConversation(port: number): Promise<Listed> {
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/conversations.json`);
      const payload = (await response.json()) as { conversations: Listed[] };
      const one = payload.conversations[0];
      if (one !== undefined && one.turns > 0) return one;
    } catch {
      // Still coming up.
    }
    if (Date.now() > deadline) throw new Error("the web view never listed the conversation");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
