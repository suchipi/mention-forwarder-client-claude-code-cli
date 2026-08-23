import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  send(prompt: string, id?: string): string;
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

function start({ dir, scenario = "plain", args = [], env = {}, conversationKey = "test:1" }: StartOptions): Session {
  const child: ChildProcess = spawn("node", [cliPath, "--binary", stubPath, "--cwd", dir, "--log-level", "debug", ...args], {
    cwd: resolve(here, ".."),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CLAUDE_STUB_SCENARIO: scenario, ...env },
  });

  let log = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (log += chunk));
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (log += chunk));

  let seq = 0;
  return {
    send(prompt, id) {
      seq += 1;
      const replyFile = join(dir, `reply-${id ?? seq}.md`);
      child.stdin?.write(
        `${JSON.stringify({
          id: id ?? `m${seq}`,
          conversationKey,
          replyFile,
          platform: "github",
          kind: "issue_comment",
          url: `https://example.com/issues/1#c${seq}`,
          text: `@bot ${prompt}`,
          prompt,
          author: "suchipi",
          title: "A test issue",
          receivedAt: "2026-08-22T00:00:00.000Z",
        })}\n`,
      );
      return replyFile;
    },

    async waitFor(replyFile, contains) {
      const deadline = Date.now() + 15000;
      for (;;) {
        if (existsSync(replyFile)) {
          const body = readFileSync(replyFile, "utf8");
          if (contains === undefined ? body.trim() !== "" : body.includes(contains)) return body;
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for ${replyFile}${contains === undefined ? "" : ` to contain ${contains}`}\n${log}`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    },

    end() {
      child.stdin?.end();
      return new Promise((done) => child.once("close", (code) => done({ code, log })));
    },
  };
}

describe("driving the claude CLI", () => {
  it("posts what the agent said, and tells it where it is", async () => {
    const dir = workspace();
    const transcript = join(dir, "transcript.txt");
    const session = start({ dir, env: { CLAUDE_STUB_TRANSCRIPT: transcript }, args: ["--no-state"] });

    const reply = session.send("please look at the flaky test");
    match(await session.waitFor(reply), /stub answered turn 1/);

    const { code } = await session.end();
    strictEqual(code, 0);

    const told = readFileSync(transcript, "utf8");
    match(told, /\[test:1\] A test issue/);
    match(told, /from @suchipi via github issue_comment/);
    match(told, /https:\/\/example\.com\/issues\/1#c1/);
    match(told, /posted back to that thread as a comment/);
    match(told, /please look at the flaky test/);
  });

  it("opens the session once and keeps it for later mentions", async () => {
    const dir = workspace();
    const transcript = join(dir, "transcript.txt");
    const session = start({ dir, env: { CLAUDE_STUB_TRANSCRIPT: transcript }, args: ["--no-state"] });

    await session.waitFor(session.send("first"));
    await session.waitFor(session.send("second"));
    await session.end();

    const turns = readFileSync(transcript, "utf8").split("\n---\n").filter((one) => one.trim() !== "");
    strictEqual(turns.length, 2);
    match(turns[0] ?? "", /posted back to that thread as a comment/);
    ok(!(turns[1] ?? "").includes("posted back to that thread as a comment"), "the second mention repeats the framing");
    match(turns[1] ?? "", /second/);
  });

  it("posts a permission request and runs the tool once someone approves", async () => {
    const dir = workspace();
    const session = start({ dir, scenario: "ask", args: ["--no-state"] });

    const first = session.send("write the file");
    const asked = await session.waitFor(first, "needs permission");
    match(asked, /`Write`/);
    match(asked, /Reply `approve`/);

    const second = session.send("approve");
    match(await session.waitFor(second), /stub wrote the file/);
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
    const session = start({ dir, scenario: "hang", args: ["--no-state"] });

    session.send("do something that never finishes");
    const stopped = session.send("[stop] do this instead");
    const body = await session.waitFor(stopped, "Stopped");
    match(body, /Stopped, as asked\./);
    // The stub only ever hangs on the first turn, so the second answers.
    match(await session.waitFor(stopped, "stub answered"), /do this instead/);
    await session.end();
  });

  it("stops a turn that is waiting on a permission request", async () => {
    const dir = workspace();
    const session = start({ dir, scenario: "ask", args: ["--no-state"] });

    await session.waitFor(session.send("write the file"), "needs permission");
    const stopped = session.send("[int]");
    const body = await session.waitFor(stopped, "Stopped");
    match(body, /Stopped, as asked\./);
    ok(!body.includes("no longer waiting on an answer"), "the withdrawn ask was narrated as well");
    await session.end();
  });

  it("says so when an interrupt arrives with nothing to stop", async () => {
    const dir = workspace();
    const session = start({ dir, scenario: "plain", args: ["--no-state"] });

    match(await session.waitFor(session.send("[stop]"), "nothing to stop"), /Nothing was running/);
    await session.end();
  });

  it("gives the agent the refusal a person wrote", async () => {
    const dir = workspace();
    const session = start({ dir, scenario: "ask", args: ["--no-state"] });

    await session.waitFor(session.send("write the file"), "needs permission");
    const second = session.send("no, that file is generated");
    match(await session.waitFor(second), /stub was told: no, that file is generated/);
    await session.end();
  });

  it("posts a question with its options and passes the answer back", async () => {
    const dir = workspace();
    const session = start({ dir, scenario: "question", args: ["--no-state"] });

    const asked = await session.waitFor(session.send("ask me something"), "has a question");
    match(asked, /Tabs or spaces\?/);
    match(asked, /- `Tabs`: hard tabs/);

    const second = session.send("spaces");
    match(await session.waitFor(second), /The person you asked replied, in the thread: spaces/);
    await session.end();
  });

  it("approves everything under --approval allow", async () => {
    const dir = workspace();
    const session = start({ dir, scenario: "ask", args: ["--no-state", "--approval", "allow"] });

    const reply = session.send("write the file");
    match(await session.waitFor(reply), /stub wrote the file/);
    await session.end();
  });

  it("refuses everything under --approval deny, and says what it skipped", async () => {
    const dir = workspace();
    const session = start({ dir, scenario: "ask", args: ["--no-state", "--approval", "deny"] });

    const reply = session.send("write the file");
    const body = await session.waitFor(reply, "stopped short of running");
    match(body, /`Write`/);
    await session.end();
  });

  it("runs mentions one at a time, in the order they arrived", async () => {
    const dir = workspace();
    const transcript = join(dir, "transcript.txt");
    const session = start({ dir, scenario: "slow", env: { CLAUDE_STUB_TRANSCRIPT: transcript }, args: ["--no-state"] });

    // Both written before the first turn can finish, so the second has to queue.
    const first = session.send("first");
    const second = session.send("second");
    match(await session.waitFor(first), /stub answered turn 1: first/);
    match(await session.waitFor(second), /stub answered turn 2: second/);
    await session.end();

    const turns = readFileSync(transcript, "utf8").split("\n---\n").filter((one) => one.trim() !== "");
    strictEqual(turns.length, 2);
  });

  it("answers a waiting request with the next mention, not with a new turn", async () => {
    const dir = workspace();
    const transcript = join(dir, "transcript.txt");
    const session = start({ dir, scenario: "ask", env: { CLAUDE_STUB_TRANSCRIPT: transcript }, args: ["--no-state"] });

    await session.waitFor(session.send("write the file"), "needs permission");
    await session.waitFor(session.send("approve"), "stub wrote the file");
    await session.end();

    // One turn, not two: the approval was a decision, not another thing to run.
    const turns = readFileSync(transcript, "utf8").split("\n---\n").filter((one) => one.trim() !== "");
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

    const second = start({ dir, args: ["--state-file", stateFile], env: { CLAUDE_STUB_ARGV_FILE: argvFile } });
    await second.waitFor(second.send("second", "b"));
    await second.end();

    const argv = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
    ok(argv.includes(`--resume=${entry.sessionId}`), `expected a resume flag in ${JSON.stringify(argv)}`);
  });

  it("passes the flags claude needs to speak this protocol", async () => {
    const dir = workspace();
    const argvFile = join(dir, "argv.json");
    const session = start({
      dir,
      args: ["--no-state", "--model", "opus", "--effort", "high", "--permission-mode", "acceptEdits", "--claude-arg=--fallback-model=sonnet"],
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

  it("posts only the answer under --progress final", async () => {
    const dir = workspace();
    const session = start({ dir, args: ["--no-state", "--progress", "final"] });
    const reply = session.send("hello");
    match(await session.waitFor(reply), /stub answered turn 1/);
    await session.end();
  });

  it("records raw events when asked to", async () => {
    const dir = workspace();
    const record = join(dir, "events.jsonl");
    const session = start({ dir, args: ["--no-state", "--record", record] });
    await session.waitFor(session.send("hello"));
    await session.end();

    const lines = readFileSync(record, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    ok(lines.some((event) => event.type === "system"));
    ok(lines.some((event) => event.type === "result"));
  });
});
