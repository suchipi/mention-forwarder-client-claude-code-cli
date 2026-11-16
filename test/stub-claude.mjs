#!/usr/bin/env node
// A stand-in for the `claude` binary: speaks just enough of the stream-json
// control protocol for the end-to-end test, scripted by CLAUDE_STUB_SCENARIO.
//
// Not part of the program. It exists so the whole pipeline (argv, framing,
// patterns, the conversation, the reply file) can be tested without a model.
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const scenario = process.env.CLAUDE_STUB_SCENARIO ?? "plain";
const argvFile = process.env.CLAUDE_STUB_ARGV_FILE;
if (argvFile !== undefined)
  writeFileSync(argvFile, JSON.stringify(process.argv.slice(2)));

const resumed = process.argv
  .slice(2)
  .find((arg) => arg.startsWith("--resume="));
// What the real CLI does with --fork-session: the history it resumed is carried
// on under an id of its own, leaving the session it came from where it was.
const forked = process.argv.slice(2).includes("--fork-session");
const sessionId =
  resumed === undefined
    ? "11111111-2222-3333-4444-555555555555"
    : forked
      ? "99999999-8888-7777-6666-555555555555"
      : resumed.slice("--resume=".length);

if (scenario === "crash") process.exit(3);

function out(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function emitInit() {
  out({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "stub",
    permissionMode: "default",
    tools: ["Write"],
  });
}

function emitText(text) {
  out({
    type: "assistant",
    message: {
      role: "assistant",
      id: "msg_stub",
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  });
}

function emitResult(text, extra = {}) {
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    permission_denials: [],
    session_id: sessionId,
    ...extra,
  });
}

function emitBackgroundTasks(tasks) {
  out({ type: "system", subtype: "background_tasks_changed", tasks, session_id: sessionId });
}

/** The three shapes a `can_use_tool` ask arrives in, one scenario each. */
const ASKS = {
  ask: {
    prose: "stub is about to write notes.txt",
    allowed: "stub wrote the file",
    request: {
      tool_name: "Write",
      input: { file_path: "notes.txt", content: "hi" },
      description: "notes.txt",
    },
  },
  question: {
    prose: "stub is about to ask something",
    allowed: "stub wrote the file",
    request: {
      tool_name: "AskUserQuestion",
      requires_user_interaction: true,
      input: {
        questions: [
          {
            question: "Tabs or spaces?",
            header: "Style",
            options: [
              { label: "Tabs", description: "hard tabs" },
              { label: "Spaces", description: "soft tabs" },
            ],
          },
        ],
      },
    },
  },
  // A tool that wants a card of its own and still does real work once somebody
  // says yes, which is what must not be mistaken for a question.
  card: {
    prose: "stub is about to make a worktree",
    allowed: "stub made the worktree",
    request: {
      tool_name: "EnterWorktree",
      requires_user_interaction: true,
      input: { branch: "lily/a-branch" },
      description: "a worktree for ENG-1234",
    },
  },
};

let pendingAsk;
/** Set while a turn is deliberately holding its answer back, so a test can land a message inside it. */
let pendingAnswer;
/** Whether a turn is in flight, which is what makes an arriving message a steer rather than a new turn. */
let running = false;
let turns = 0;
let steered = [];

/** How long the `steer` scenario waits to be steered before answering anyway, so a mis-wired test fails rather than hangs. */
const STEER_BACKSTOP_MS = 2000;

/**
 * What the real CLI does when it resumes a session that left background work
 * behind: a task notification of its own goes in front of whatever is sent next,
 * and is closed without ever reaching the model.
 */
function emitQueuedNotification() {
  out({ type: "system", subtype: "task_notification", session_id: sessionId });
  emitInit();
  emitResult("", {
    num_turns: 0,
    duration_ms: 45,
    total_cost_usd: 0,
    stop_reason: null,
    // CLAUDE_STUB_QUEUED_NOTIFICATION=no-origin is a release that names none,
    // which leaves only the shape of the end to recognize it by.
    ...(process.env.CLAUDE_STUB_QUEUED_NOTIFICATION === "no-origin"
      ? {}
      : { origin: { kind: "task-notification" } }),
  });
}

/**
 * The CLI running a prompt it queued for itself. A message arriving while one is
 * in flight is queued behind it rather than joining it, which is what the real
 * CLI does and what makes that end easy to mistake for the queued message's own.
 */
let ownPromptRunning = false;
let queuedPrompt;

function endOwnPrompt(end) {
  end();
  ownPromptRunning = false;
  const queued = queuedPrompt;
  queuedPrompt = undefined;
  if (queued !== undefined) runTurn(queued);
}

function finishOwnPrompt(said) {
  endOwnPrompt(() => {
    emitText(said);
    emitResult(said, { num_turns: 1, origin: { kind: "task-notification" } });
  });
}

function failOwnPrompt(detail) {
  endOwnPrompt(() => {
    out({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      result: detail,
      error: detail,
      permission_denials: [],
      session_id: sessionId,
      num_turns: 1,
      origin: { kind: "task-notification" },
    });
  });
}

/**
 * What the real CLI does with a `/compact`: a status while it works and another
 * saying how it went, a fresh init, the boundary a compacted session picks up
 * from, and a turn end with nothing in it. The model is never called.
 */
function runCompaction() {
  const failed = process.env.CLAUDE_STUB_COMPACT === "fail";
  // What the real CLI does when a message reached it while a turn was running:
  // it answers that as a prompt of its own before it gets to the command.
  if (process.env.CLAUDE_STUB_COMPACT === "queued") {
    emitInit();
    emitText("stub answered a prompt it had queued");
    emitResult("stub answered a prompt it had queued", { num_turns: 1 });
  }
  out({ type: "system", subtype: "status", status: "compacting", session_id: sessionId });
  out({
    type: "system",
    subtype: "status",
    status: null,
    session_id: sessionId,
    compact_result: failed ? "failed" : "success",
    ...(failed ? { compact_error: "Not enough messages to compact." } : {}),
  });
  emitInit();
  if (failed) emitText("Not enough messages to compact.");
  else
    out({
      type: "system",
      subtype: "compact_boundary",
      session_id: sessionId,
      compact_metadata: { trigger: "manual", pre_tokens: 29169, post_tokens: 1193 },
    });
  // A compaction that failed says why on its result as well; one that worked
  // ends with nothing in it, the same shape as a prompt the CLI ran for itself.
  emitResult(failed ? "Not enough messages to compact." : "", {
    num_turns: 0,
    duration_ms: 12,
    total_cost_usd: 0,
    stop_reason: null,
  });
}

function runTurn(text) {
  if (process.env.CLAUDE_STUB_QUEUED_NOTIFICATION !== undefined && turns === 0)
    emitQueuedNotification();
  turns += 1;
  running = true;
  steered = [];
  emitInit();

  if (process.env.CLAUDE_STUB_TRANSCRIPT !== undefined) {
    appendFileSync(process.env.CLAUDE_STUB_TRANSCRIPT, `${text}\n---\n`);
  }

  const shape = ASKS[scenario];
  if (shape !== undefined && turns === 1) {
    const requestId = "ask-1";
    // The model says what it is about to do before it asks to do it, which is
    // the context `--progress final` would otherwise keep from the thread.
    emitText(shape.prose);
    out({
      type: "assistant",
      message: {
        role: "assistant",
        id: "msg_stub_tool",
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: shape.request.tool_name,
            input: shape.request.input,
          },
        ],
      },
      parent_tool_use_id: null,
      session_id: sessionId,
    });
    out({
      type: "control_request",
      request_id: requestId,
      request: { subtype: "can_use_tool", tool_use_id: "toolu_1", ...shape.request },
    });
    pendingAsk = requestId;
    return;
  }

  // What the real CLI does with a background task: the turn ends while the task
  // is still running, and finishing it prompts the agent again of its own accord.
  // CLAUDE_STUB_BACKGROUND=doomed leaves the task running for good, which is the
  // shape of a watcher whose own loop can never finish.
  if (scenario === "background" && turns === 1) {
    emitBackgroundTasks([{ task_id: "bg-1", task_type: "local_bash", description: "sleep 45" }]);
    emitText("stub started something in the background");
    emitResult("stub started something in the background", { num_turns: 2 });
    running = false;
    if (process.env.CLAUDE_STUB_BACKGROUND === "doomed") return;
    setTimeout(() => {
      emitBackgroundTasks([]);
      emitInit();
      ownPromptRunning = true;
      // Long enough for a test to get a mention in while that prompt is running.
      if (process.env.CLAUDE_STUB_BACKGROUND === "late-mention")
        setTimeout(() => failOwnPrompt("the stub's own prompt hit a rate limit"), 300);
      else finishOwnPrompt("stub finished the background thing");
    }, 150);
    return;
  }

  // Answers nothing at all, so a test can interrupt the turn without racing it.
  // A forked child answers as usual, so a test can watch one thread being
  // answered while the thread it came out of is stuck.
  if (scenario === "hang" && turns === 1 && !forked) return;

  // Idempotent, because the steer backstop below can race the steer itself, and
  // a turn that answered twice would look like two turns to the program.
  let answered = false;
  const answer = () => {
    if (answered) return;
    answered = true;
    pendingAnswer = undefined;
    const tail =
      steered.length === 0 ? "" : ` +steered: ${steered.join(" | ")}`;
    emitText(`stub answered turn ${turns}: ${text.split("\n").at(-1)}${tail}`);
    emitResult(`stub answered turn ${turns}${tail}`);
    running = false;
  };

  // Holds the answer until something is steered in, so the test never races it.
  if (scenario === "steer" && turns === 1) {
    pendingAnswer = answer;
    setTimeout(answer, STEER_BACKSTOP_MS).unref();
    return;
  }
  if (scenario === "slow") setTimeout(answer, 300);
  else answer();
}

function settleAsk(response) {
  pendingAsk = undefined;
  running = false;
  const allowed = response?.behavior === "allow";
  out({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          is_error: !allowed,
          content: allowed ? "written" : String(response?.message ?? ""),
        },
      ],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
  });
  const text = allowed
    ? ASKS[scenario].allowed
    : `stub was told: ${String(response?.message ?? "")}`;
  emitText(text);
  emitResult(
    text,
    allowed
      ? {}
      : {
          permission_denials: [
            {
              tool_name: ASKS[scenario].request.tool_name,
              tool_use_id: "toolu_1",
              tool_input: { file_path: "notes.txt" },
            },
          ],
        },
  );
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim() === "") return;
  const frame = JSON.parse(line);

  if (frame.type === "control_request") {
    // The real CLI withdraws a waiting ask, acks, and ends the turn as an error.
    if (frame.request?.subtype === "interrupt") {
      if (pendingAsk !== undefined) {
        out({ type: "control_cancel_request", request_id: pendingAsk });
        pendingAsk = undefined;
      }
      running = false;
      pendingAnswer = undefined;
      out({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: frame.request_id,
          response: { still_queued: [], cancelled: [] },
        },
      });
      out({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "",
        permission_denials: [],
        session_id: sessionId,
      });
      return;
    }
    out({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: frame.request_id,
        response: {},
      },
    });
    return;
  }
  if (frame.type === "control_response") {
    if (frame.response?.request_id === pendingAsk)
      settleAsk(frame.response.response);
    return;
  }
  if (frame.type === "user") {
    const text = frame.message.content
      .map((block) => block.text ?? "")
      .join("");

    if (ownPromptRunning) {
      queuedPrompt = text;
      return;
    }
    // What the real CLI does with a message written part-way through a turn: it
    // joins that turn rather than starting another one.
    if (running) {
      steered.push(text.split("\n").at(-1));
      if (process.env.CLAUDE_STUB_STEERS !== undefined) {
        appendFileSync(process.env.CLAUDE_STUB_STEERS, `${text}\n---\n`);
      }
      pendingAnswer?.();
      return;
    }
    // A message that is nothing but a slash command is the command itself, which
    // is the only way one can be given over this protocol.
    if (text.trim() === "/compact") {
      runCompaction();
      return;
    }
    runTurn(text);
  }
});

process.stdin.on("end", () => process.exit(0));
