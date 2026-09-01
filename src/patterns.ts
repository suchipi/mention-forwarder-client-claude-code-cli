import { pathToFileURL } from "node:url";
import type { Logger } from "./logger.ts";
import type { Denial, RawEvent, Signal, ToolRef } from "./signals.ts";

/**
 * One recognizer. `match` returns the signals an event means, or `null` when the
 * event is not this rule's business, in which case the next rule is tried.
 *
 * Returning an empty array claims the event and says it means nothing, which is
 * how noise is silenced without it showing up as unrecognized.
 */
export type Rule = {
  /** Stable id. A patterns file refers to a rule by this, so renaming one is a breaking change. */
  name: string;
  /** The event shape this claims, for the log and for whoever has to update it next. */
  shape: string;
  match(event: RawEvent): Signal[] | null;
};

/** A patterns file's default export: given the built-in rules, return the ones to use. */
export type RulePatch = (rules: Rule[]) => Rule[] | Promise<Rule[]>;

// --- reading values out of an event without ever throwing on an unexpected shape ---

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  return list(value).filter((one): one is string => typeof one === "string");
}

/** Tool results arrive as a string or as a list of content blocks, depending on the tool. */
function flattenContent(value: unknown): string {
  if (typeof value === "string") return value;
  const parts = list(value).map((block) => {
    const one = record(block);
    return str(one["text"]) ?? `[${str(one["type"]) ?? "block"}]`;
  });
  return parts.join("\n");
}

function toolRef(source: Record<string, unknown>, nameKey: string, idKey: string, inputKey: string): ToolRef {
  return {
    name: str(source[nameKey]) ?? "an unnamed tool",
    input: record(source[inputKey]),
    toolUseId: str(source[idKey]) ?? "",
  };
}

// --- the built-in rules, tried in this order ---

/**
 * `requires_user_interaction` is set by any tool that wants a card of its own,
 * including ones that go on to do real work once somebody says yes. Only the
 * tool whose card *is* the question carries questions, and only that one has
 * nothing a person could approve.
 */
function hasNothingToApprove(request: Record<string, unknown>): boolean {
  if (request["requires_user_interaction"] !== true) return false;
  return list(record(request["input"])["questions"]).some((entry) => str(record(entry)["question"]) !== undefined);
}

/**
 * Permission asks and questions. Both arrive as `can_use_tool`; the ones whose
 * own card is the interaction (`AskUserQuestion`) set `requires_user_interaction`
 * and carry the questions themselves.
 */
const canUseTool: Rule = {
  name: "control-request/can-use-tool",
  shape: `{"type":"control_request","request_id":…,"request":{"subtype":"can_use_tool","tool_name":…,"input":{…},"tool_use_id":…}}`,
  match(event) {
    if (event["type"] !== "control_request") return null;
    const request = record(event["request"]);
    if (request["subtype"] !== "can_use_tool") return null;
    const requestId = str(event["request_id"]);
    if (requestId === undefined) return [];
    return [
      {
        kind: "ask",
        requestId,
        tool: toolRef(request, "tool_name", "tool_use_id", "input"),
        isQuestion: hasNothingToApprove(request),
        title: str(request["title"]),
        description: str(request["description"]),
        reason: str(request["decision_reason"]),
      },
    ];
  },
};

const otherControlRequest: Rule = {
  name: "control-request/other",
  shape: `{"type":"control_request","request":{"subtype":<anything else>}}`,
  match(event) {
    if (event["type"] !== "control_request") return null;
    const subtype = str(record(event["request"])["subtype"]) ?? "unknown";
    return [{ kind: "notice", level: "debug", text: `ignoring a ${subtype} control request`, fields: {} }];
  },
};

const controlCancel: Rule = {
  name: "control-cancel-request",
  shape: `{"type":"control_cancel_request","request_id":…}`,
  match(event) {
    if (event["type"] !== "control_cancel_request") return null;
    const requestId = str(event["request_id"]);
    return requestId === undefined ? [] : [{ kind: "ask-withdrawn", requestId }];
  },
};

const controlResponse: Rule = {
  name: "control-response",
  shape: `{"type":"control_response","response":{"subtype":"success"|"error","request_id":…}}`,
  match(event) {
    if (event["type"] !== "control_response") return null;
    const response = record(event["response"]);
    const requestId = str(response["request_id"]);
    if (requestId === undefined) return [];
    return [
      {
        kind: "control-reply",
        requestId,
        ok: response["subtype"] === "success",
        payload: record(response["response"]),
        error: str(response["error"]),
      },
    ];
  },
};

const init: Rule = {
  name: "system/init",
  shape: `{"type":"system","subtype":"init","session_id":…,"model":…,"permissionMode":…,"tools":[…]}`,
  match(event) {
    if (event["type"] !== "system" || event["subtype"] !== "init") return null;
    const sessionId = str(event["session_id"]);
    if (sessionId === undefined) return [];
    return [
      {
        kind: "session",
        sessionId,
        model: str(event["model"]),
        permissionMode: str(event["permissionMode"]),
        tools: strings(event["tools"]),
      },
    ];
  },
};

const permissionDenied: Rule = {
  name: "system/permission-denied",
  shape: `{"type":"system","subtype":"permission_denied","tool_name":…,"tool_use_id":…,"message":…}`,
  match(event) {
    if (event["type"] !== "system" || event["subtype"] !== "permission_denied") return null;
    return [
      {
        kind: "auto-denied",
        toolName: str(event["tool_name"]) ?? "a tool",
        toolUseId: str(event["tool_use_id"]) ?? "",
        message: str(event["message"]) ?? "the CLI refused the tool without asking",
      },
    ];
  },
};

const thinkingTokens: Rule = {
  name: "system/thinking-tokens",
  shape: `{"type":"system","subtype":"thinking_tokens","estimated_tokens":…}`,
  match(event) {
    if (event["type"] !== "system" || event["subtype"] !== "thinking_tokens") return null;
    return [{ kind: "ignored", why: "a thinking-token tick" }];
  },
};

const assistantMessage: Rule = {
  name: "assistant-message",
  shape: `{"type":"assistant","message":{"content":[{"type":"text"|"thinking"|"tool_use",…}]},"parent_tool_use_id":…}`,
  match(event) {
    if (event["type"] !== "assistant") return null;
    const fromSubagent = str(event["parent_tool_use_id"]) !== undefined;
    const signals: Signal[] = [];
    for (const raw of list(record(event["message"])["content"])) {
      const block = record(raw);
      switch (block["type"]) {
        case "text": {
          const text = str(block["text"]);
          if (text !== undefined && text.trim() !== "") signals.push({ kind: "text", text, fromSubagent });
          break;
        }
        case "thinking":
        case "redacted_thinking": {
          signals.push({ kind: "thinking", chars: (str(block["thinking"]) ?? "").length, fromSubagent });
          break;
        }
        case "tool_use":
        case "server_tool_use": {
          signals.push({ kind: "tool-start", tool: toolRef(block, "name", "id", "input"), fromSubagent });
          break;
        }
        default:
          break;
      }
    }
    return signals;
  },
};

const toolResults: Rule = {
  name: "user-message/tool-results",
  shape: `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":…,"is_error":…}]}}`,
  match(event) {
    if (event["type"] !== "user") return null;
    const fromSubagent = str(event["parent_tool_use_id"]) !== undefined;
    const signals: Signal[] = [];
    for (const raw of list(record(event["message"])["content"])) {
      const block = record(raw);
      if (block["type"] !== "tool_result") continue;
      signals.push({
        kind: "tool-end",
        toolUseId: str(block["tool_use_id"]) ?? "",
        isError: block["is_error"] === true,
        summary: flattenContent(block["content"]),
        fromSubagent,
      });
    }
    return signals;
  },
};

function denialsOf(event: RawEvent): Denial[] {
  return list(event["permission_denials"]).map((raw) => {
    const one = record(raw);
    return {
      toolName: str(one["tool_name"]) ?? "a tool",
      toolUseId: str(one["tool_use_id"]) ?? "",
      input: record(one["tool_input"]),
    };
  });
}

const result: Rule = {
  name: "result",
  shape: `{"type":"result","subtype":"success"|"error_…","is_error":…,"result":…,"num_turns":…,"permission_denials":[…]}`,
  match(event) {
    if (event["type"] !== "result") return null;
    const ok = event["subtype"] === "success" && event["is_error"] !== true;
    return [
      {
        kind: "turn-end",
        ok,
        text: str(event["result"]) ?? "",
        error: ok ? undefined : (str(event["error"]) ?? str(event["result"]) ?? str(event["subtype"]) ?? "the turn failed"),
        denials: denialsOf(event),
        costUsd: num(event["total_cost_usd"]),
        durationMs: num(event["duration_ms"]),
        modelTurns: num(event["num_turns"]),
      },
    ];
  },
};

const rateLimit: Rule = {
  name: "rate-limit-event",
  shape: `{"type":"rate_limit_event","rate_limit_info":{"status":…,"resetsAt":…}}`,
  match(event) {
    if (event["type"] !== "rate_limit_event") return null;
    const info = record(event["rate_limit_info"]);
    const status = str(info["status"]) ?? "unknown";
    return [
      {
        kind: "notice",
        level: status === "allowed" ? "debug" : "warn",
        text: `rate limit status: ${status}`,
        fields: { type: str(info["rateLimitType"]), resetsAt: num(info["resetsAt"]) },
      },
    ];
  },
};

const streamEvent: Rule = {
  name: "stream-event",
  shape: `{"type":"stream_event",…}, the partial chunks only sent with --include-partial-messages`,
  match(event) {
    if (event["type"] !== "stream_event") return null;
    return [{ kind: "ignored", why: "a partial message chunk" }];
  },
};

const keepAlive: Rule = {
  name: "keep-alive",
  shape: `{"type":"keep_alive"}`,
  match(event) {
    if (event["type"] !== "keep_alive") return null;
    return [{ kind: "ignored", why: "a keep-alive" }];
  },
};

/** Everything else the CLI files under `system`: compaction, API retries, hook events. */
const otherSystem: Rule = {
  name: "system/other",
  shape: `{"type":"system","subtype":<anything else>}`,
  match(event) {
    if (event["type"] !== "system") return null;
    const subtype = str(event["subtype"]) ?? "unknown";
    return [{ kind: "notice", level: "debug", text: `system event: ${subtype}`, fields: { subtype } }];
  },
};

/**
 * The order rules are tried in. Narrow shapes come before the catch-alls that
 * would also claim them, so `system/init` must stay ahead of `system/other`.
 */
export const DEFAULT_RULES: readonly Rule[] = [
  canUseTool,
  controlCancel,
  controlResponse,
  otherControlRequest,
  init,
  permissionDenied,
  thinkingTokens,
  assistantMessage,
  toolResults,
  result,
  rateLimit,
  streamEvent,
  keepAlive,
  otherSystem,
];

/** Translates one raw event into what it means. Unclaimed events are reported, never dropped. */
export function recognize(event: RawEvent, rules: readonly Rule[]): Signal[] {
  for (const rule of rules) {
    const signals = rule.match(event);
    if (signals !== null) return signals;
  }
  return [{ kind: "unrecognized", event }];
}

/**
 * The rules to run with.
 *
 * `path` names a module whose default export takes the built-in rules and returns
 * the ones to use, so a `claude` release that changes an event shape can be
 * absorbed by adding a rule ahead of the built-in one, without editing this file.
 */
export async function loadRules(path: string | undefined, log: Logger): Promise<Rule[]> {
  const builtIn = [...DEFAULT_RULES];
  if (path === undefined) return builtIn;

  const module = (await import(pathToFileURL(path).href)) as { default?: unknown };
  if (typeof module.default !== "function") {
    throw new Error(
      `the patterns file ${path} must default-export a function taking the built-in rules and returning the ones to use`,
    );
  }

  const patched = await (module.default as RulePatch)(builtIn);
  if (!Array.isArray(patched) || patched.some((rule) => typeof rule?.match !== "function")) {
    throw new Error(`the patterns file ${path} returned something other than a list of rules`);
  }

  log.info("using patched patterns", { path, rules: patched.length, builtIn: builtIn.length });
  return patched;
}
