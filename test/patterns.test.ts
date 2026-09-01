import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createLogger } from "../src/logger.ts";
import { DEFAULT_RULES, loadRules, recognize, type Rule } from "../src/patterns.ts";
import type { RawEvent, Signal } from "../src/signals.ts";

/**
 * Every event below was copied out of a real `claude --output-format stream-json`
 * run, with the long fields shortened. They are the contract this program reads,
 * so a change here is a change to what it supports.
 */
const EVENTS: Record<string, RawEvent> = {
  init: {
    type: "system",
    subtype: "init",
    cwd: "/tmp/scratch",
    session_id: "f1e89d14-365b-4c65-8656-b11274b693c0",
    tools: ["Task", "Bash", "Write"],
    model: "claude-haiku-4-5-20251001",
    permissionMode: "default",
    uuid: "e8a60044-f49b-45ed-b53c-bad81a284f0c",
  },
  thinkingTokens: {
    type: "system",
    subtype: "thinking_tokens",
    estimated_tokens: 39,
    estimated_tokens_delta: 30,
    session_id: "f1e89d14",
  },
  assistantThinking: {
    type: "assistant",
    message: { model: "claude-haiku-4-5", id: "msg_01", type: "message", role: "assistant", content: [{ type: "thinking", thinking: "hmm", signature: "x" }] },
    parent_tool_use_id: null,
    session_id: "f1e89d14",
  },
  assistantText: {
    type: "assistant",
    message: { model: "claude-haiku-4-5", id: "msg_01", type: "message", role: "assistant", content: [{ type: "text", text: "Hello, let's work." }] },
    parent_tool_use_id: null,
    session_id: "f1e89d14",
  },
  subagentText: {
    type: "assistant",
    message: { role: "assistant", id: "msg_02", content: [{ type: "text", text: "from a subagent" }] },
    parent_tool_use_id: "toolu_parent",
    session_id: "f1e89d14",
  },
  assistantToolUse: {
    type: "assistant",
    message: {
      role: "assistant",
      id: "msg_03",
      content: [{ type: "tool_use", id: "toolu_017", name: "Bash", input: { command: "echo hello-from-bash", description: "Echo" } }],
    },
    parent_tool_use_id: null,
    session_id: "f1e89d14",
  },
  toolResult: {
    type: "user",
    message: { role: "user", content: [{ tool_use_id: "toolu_017", type: "tool_result", content: "hello-from-bash", is_error: false }] },
    parent_tool_use_id: null,
    session_id: "f1e89d14",
    tool_use_result: { stdout: "hello-from-bash", stderr: "", interrupted: false },
  },
  permissionAsk: {
    type: "control_request",
    request_id: "72f80e0e-cd4e-4700-bf49-01f4cdf02fdc",
    request: {
      subtype: "can_use_tool",
      tool_name: "Write",
      display_name: "Write",
      input: { file_path: "/tmp/scratch/probe2.txt", content: "banana" },
      description: "probe2.txt",
      permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
      tool_use_id: "toolu_013",
    },
  },
  questionAsk: {
    type: "control_request",
    request_id: "e344effc-ae25-4db4-b49b-728131ec85a3",
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      display_name: "AskUserQuestion",
      input: { questions: [{ question: "Tabs or spaces?", header: "Code style", options: [], multiSelect: false }] },
      tool_use_id: "toolu_01W",
      requires_user_interaction: true,
    },
  },
  cardAsk: {
    type: "control_request",
    request_id: "b21c0f3a-1d7e-4a55-9c11-8e0f4a2b6d90",
    request: {
      subtype: "can_use_tool",
      tool_name: "EnterWorktree",
      display_name: "EnterWorktree",
      input: { branch: "lily/a-branch" },
      description: "a worktree for ENG-1234",
      tool_use_id: "toolu_01E",
      requires_user_interaction: true,
    },
  },
  cancel: { type: "control_cancel_request", request_id: "e344effc-ae25-4db4-b49b-728131ec85a3" },
  controlResponse: { type: "control_response", response: { subtype: "success", request_id: "mfc-1", response: { commands: [] } } },
  controlError: { type: "control_response", response: { subtype: "error", request_id: "mfc-2", error: "unknown subtype" } },
  permissionDenied: {
    type: "system",
    subtype: "permission_denied",
    tool_name: "Write",
    tool_use_id: "toolu_01G",
    message: "Claude requested permissions to write to /tmp/x, but you haven't granted it yet.",
    session_id: "267e57a5",
  },
  resultSuccess: {
    is_error: false,
    duration_api_ms: 5004,
    num_turns: 1,
    stop_reason: "end_turn",
    session_id: "f1e89d14",
    total_cost_usd: 0.0211554,
    permission_denials: [],
    terminal_reason: "completed",
    subtype: "success",
    result: "Hello, let's work.",
    type: "result",
    duration_ms: 4237,
  },
  resultDenied: {
    is_error: false,
    session_id: "5d3d67",
    permission_denials: [{ tool_name: "AskUserQuestion", tool_use_id: "toolu_01U", tool_input: { questions: [] } }],
    subtype: "success",
    result: "I attempted to ask you that question",
    type: "result",
  },
  resultOfItsOwnPrompt: {
    is_error: false,
    session_id: "f1e89d14",
    permission_denials: [],
    subtype: "success",
    result: "",
    num_turns: 0,
    duration_ms: 45,
    total_cost_usd: 0,
    stop_reason: null,
    type: "result",
  },
  resultFailure: {
    is_error: true,
    session_id: "f1e89d14",
    permission_denials: [],
    subtype: "error_during_execution",
    result: "the model is unavailable",
    type: "result",
  },
  compacting: {
    type: "system",
    subtype: "status",
    status: "compacting",
    session_id: "f1e89d14",
    uuid: "4f694641-36ba-49ce-927d-5dc0753b05cd",
  },
  compactionSucceeded: {
    type: "system",
    subtype: "status",
    status: null,
    compact_result: "success",
    session_id: "f1e89d14",
    uuid: "491932cb-d63b-4163-b38a-bf430d95725e",
  },
  compactionFailed: {
    type: "system",
    subtype: "status",
    status: null,
    compact_result: "failed",
    compact_error: "Not enough messages to compact.",
    session_id: "f1e89d14",
    uuid: "5949972b-3e77-4ec4-885a-79ae33cc7113",
  },
  compactBoundary: {
    type: "system",
    subtype: "compact_boundary",
    session_id: "f1e89d14",
    uuid: "99c88dd9-0885-4589-baf5-d92dc7274eaa",
    compact_metadata: {
      trigger: "manual",
      pre_tokens: 29169,
      post_tokens: 1193,
      cumulative_dropped_tokens: 27976,
      duration_ms: 15642,
    },
  },
  // What a `/compact` ends with: the same shape as a prompt the CLI ran for
  // itself, which is why only the turn it belongs to can tell them apart.
  resultOfACompaction: {
    is_error: false,
    session_id: "f1e89d14",
    permission_denials: [],
    subtype: "success",
    result: "",
    num_turns: 0,
    duration_ms: 15655,
    stop_reason: null,
    type: "result",
  },
  rateLimit: {
    type: "rate_limit_event",
    rate_limit_info: { status: "allowed", resetsAt: 1787408400, rateLimitType: "five_hour" },
    session_id: "f1e89d14",
  },
};

function read(event: RawEvent): Signal[] {
  return recognize(event, DEFAULT_RULES);
}

function only(event: RawEvent): Signal {
  const signals = read(event);
  strictEqual(signals.length, 1, `expected one signal, got ${JSON.stringify(signals)}`);
  return signals[0] as Signal;
}

describe("recognizing what claude says", () => {
  it("reads the session out of an init event", () => {
    deepStrictEqual(only(EVENTS["init"] as RawEvent), {
      kind: "session",
      sessionId: "f1e89d14-365b-4c65-8656-b11274b693c0",
      model: "claude-haiku-4-5-20251001",
      permissionMode: "default",
      tools: ["Task", "Bash", "Write"],
    });
  });

  it("keeps init ahead of the catch-all for system events", () => {
    // Ordering is load-bearing: system/other would claim an init too.
    strictEqual(only({ type: "system", subtype: "hook_event" } as RawEvent).kind, "notice");
    strictEqual(only(EVENTS["init"] as RawEvent).kind, "session");
  });

  it("reads a compaction off the boundary it leaves behind", () => {
    const compacted = only(EVENTS["compactBoundary"] as RawEvent);
    strictEqual(compacted.kind, "compacted");
    if (compacted.kind !== "compacted") return;
    strictEqual(compacted.ok, true);
    strictEqual(compacted.preTokens, 29169);
    strictEqual(compacted.postTokens, 1193);
  });

  it("reads why a compaction did not happen", () => {
    const compacted = only(EVENTS["compactionFailed"] as RawEvent);
    strictEqual(compacted.kind, "compacted");
    if (compacted.kind !== "compacted") return;
    strictEqual(compacted.ok, false);
    strictEqual(compacted.error, "Not enough messages to compact.");
  });

  it("says nothing twice about a compaction that worked", () => {
    // Both events arrive; the boundary is the one with the sizes on it.
    strictEqual(only(EVENTS["compactionSucceeded"] as RawEvent).kind, "ignored");
  });

  it("leaves a status event that is not about compacting to the catch-all", () => {
    strictEqual(only(EVENTS["compacting"] as RawEvent).kind, "notice");
  });

  it("cannot tell the end of a compaction from any other empty one", () => {
    // Which is why nothing here tries: the turn it belongs to is what knows.
    const done = only(EVENTS["resultOfACompaction"] as RawEvent);
    strictEqual(done.kind, "turn-end");
    if (done.kind !== "turn-end") return;
    strictEqual(done.ok, true);
    strictEqual(done.modelTurns, 0);
    strictEqual(done.text, "");
  });

  it("separates the model's prose from its thinking", () => {
    const text = only(EVENTS["assistantText"] as RawEvent);
    strictEqual(text.kind, "text");
    if (text.kind === "text") {
      strictEqual(text.text, "Hello, let's work.");
      strictEqual(text.fromSubagent, false);
    }
    strictEqual(only(EVENTS["assistantThinking"] as RawEvent).kind, "thinking");
  });

  it("marks anything a subagent said", () => {
    const signal = only(EVENTS["subagentText"] as RawEvent);
    strictEqual(signal.kind === "text" && signal.fromSubagent, true);
  });

  it("reads a tool call and its result", () => {
    const start = only(EVENTS["assistantToolUse"] as RawEvent);
    strictEqual(start.kind, "tool-start");
    if (start.kind === "tool-start") {
      strictEqual(start.tool.name, "Bash");
      strictEqual(start.tool.toolUseId, "toolu_017");
      strictEqual(start.tool.input["command"], "echo hello-from-bash");
    }

    const end = only(EVENTS["toolResult"] as RawEvent);
    strictEqual(end.kind, "tool-end");
    if (end.kind === "tool-end") {
      strictEqual(end.toolUseId, "toolu_017");
      strictEqual(end.isError, false);
      strictEqual(end.summary, "hello-from-bash");
    }
  });

  it("flattens a tool result that arrives as content blocks", () => {
    const end = only({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "one" }, { type: "image" }] }] },
    } as RawEvent);
    strictEqual(end.kind === "tool-end" && end.summary, "one\n[image]");
  });

  it("reads a permission request", () => {
    const ask = only(EVENTS["permissionAsk"] as RawEvent);
    strictEqual(ask.kind, "ask");
    if (ask.kind !== "ask") return;
    strictEqual(ask.requestId, "72f80e0e-cd4e-4700-bf49-01f4cdf02fdc");
    strictEqual(ask.tool.name, "Write");
    strictEqual(ask.tool.toolUseId, "toolu_013");
    strictEqual(ask.description, "probe2.txt");
    strictEqual(ask.isQuestion, false);
  });

  it("tells a question apart from a permission request", () => {
    const ask = only(EVENTS["questionAsk"] as RawEvent);
    strictEqual(ask.kind === "ask" && ask.isQuestion, true);
  });

  it("keeps a tool that merely wants a card of its own approvable", () => {
    const ask = only(EVENTS["cardAsk"] as RawEvent);
    strictEqual(ask.kind === "ask" && ask.isQuestion, false);
  });

  it("reads a withdrawn request", () => {
    const withdrawn = only(EVENTS["cancel"] as RawEvent);
    strictEqual(withdrawn.kind === "ask-withdrawn" && withdrawn.requestId, "e344effc-ae25-4db4-b49b-728131ec85a3");
  });

  it("reads both outcomes of a control response", () => {
    const okReply = only(EVENTS["controlResponse"] as RawEvent);
    strictEqual(okReply.kind === "control-reply" && okReply.ok, true);
    const failed = only(EVENTS["controlError"] as RawEvent);
    strictEqual(failed.kind === "control-reply" && failed.error, "unknown subtype");
  });

  it("reads a tool the CLI refused without asking", () => {
    const denied = only(EVENTS["permissionDenied"] as RawEvent);
    strictEqual(denied.kind === "auto-denied" && denied.toolName, "Write");
  });

  it("reads the end of a turn", () => {
    const done = only(EVENTS["resultSuccess"] as RawEvent);
    strictEqual(done.kind, "turn-end");
    if (done.kind !== "turn-end") return;
    strictEqual(done.ok, true);
    strictEqual(done.text, "Hello, let's work.");
    strictEqual(done.costUsd, 0.0211554);
    strictEqual(done.durationMs, 4237);
    strictEqual(done.modelTurns, 1);
    deepStrictEqual(done.denials, []);
  });

  it("counts the model turns, which is zero when the CLI never called it", () => {
    const done = only(EVENTS["resultOfItsOwnPrompt"] as RawEvent);
    strictEqual(done.kind, "turn-end");
    if (done.kind !== "turn-end") return;
    strictEqual(done.ok, true);
    strictEqual(done.modelTurns, 0);
    strictEqual(done.text, "");
  });

  it("carries the tools a turn was never allowed to run", () => {
    const done = only(EVENTS["resultDenied"] as RawEvent);
    strictEqual(done.kind === "turn-end" && done.denials.length, 1);
    if (done.kind === "turn-end") strictEqual(done.denials[0]?.toolName, "AskUserQuestion");
  });

  it("reads a failed turn as failed", () => {
    const done = only(EVENTS["resultFailure"] as RawEvent);
    strictEqual(done.kind, "turn-end");
    if (done.kind !== "turn-end") return;
    strictEqual(done.ok, false);
    strictEqual(done.error, "the model is unavailable");
  });

  it("keeps rate limits and thinking ticks out of the way", () => {
    strictEqual(only(EVENTS["rateLimit"] as RawEvent).kind, "notice");
    strictEqual(only(EVENTS["thinkingTokens"] as RawEvent).kind, "ignored");
  });

  it("reports an event no rule claims, rather than dropping it", () => {
    const signal = only({ type: "something_new_in_a_later_release", detail: 1 } as RawEvent);
    strictEqual(signal.kind, "unrecognized");
  });

  it("survives an event whose fields are the wrong shape", () => {
    deepStrictEqual(read({ type: "assistant", message: "not an object" } as RawEvent), []);
    deepStrictEqual(read({ type: "control_request", request: { subtype: "can_use_tool" } } as RawEvent), []);
    strictEqual(only({ type: "result" } as RawEvent).kind, "turn-end");
  });

  it("gives every rule a name and a shape", () => {
    for (const rule of DEFAULT_RULES) {
      strictEqual(typeof rule.name, "string");
      match(rule.shape, /\S/);
    }
    strictEqual(new Set(DEFAULT_RULES.map((rule) => rule.name)).size, DEFAULT_RULES.length);
  });
});

describe("patching the patterns", () => {
  const directory = mkdtempSync(join(tmpdir(), "mfcc-patterns-"));
  after(() => rmSync(directory, { recursive: true, force: true }));

  const log = createLogger("error");

  it("hands the built-in rules to the file and uses what comes back", async () => {
    const file = join(directory, "patch.mjs");
    writeFileSync(
      file,
      `export default (rules) => [
         { name: "mine", shape: "{\\"type\\":\\"weird\\"}", match: (event) => event.type === "weird" ? [{ kind: "ignored", why: "mine" }] : null },
         ...rules,
       ];\n`,
    );

    const rules: Rule[] = await loadRules(file, log);
    strictEqual(rules.length, DEFAULT_RULES.length + 1);
    strictEqual(recognize({ type: "weird" }, rules)[0]?.kind, "ignored");
    strictEqual(recognize(EVENTS["init"] as RawEvent, rules)[0]?.kind, "session");
  });

  it("refuses a file that does not export a function", async () => {
    const file = join(directory, "bad.mjs");
    writeFileSync(file, "export default 5;\n");
    await loadRules(file, log).then(
      () => {
        throw new Error("expected loadRules to refuse this");
      },
      (error: unknown) => match((error as Error).message, /must default-export a function/),
    );
  });
});
