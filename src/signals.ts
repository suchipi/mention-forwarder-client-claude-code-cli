/**
 * The vocabulary this program thinks in.
 *
 * Everything the `claude` process says is translated into these before any other
 * module sees it, so the rest of the program never touches a raw event shape.
 * When a future `claude` release moves a field or renames an event, only
 * `patterns.ts` has to change: see the "Pattern detection" section of the README.
 */

/** One raw newline-delimited JSON object read from the `claude` process. */
export type RawEvent = Record<string, unknown>;

/** A tool the model wants to run, or has run. */
export type ToolRef = {
  name: string;
  input: Record<string, unknown>;
  toolUseId: string;
};

/** A tool call the model made that never ran, as reported when a turn ends. */
export type Denial = {
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
};

export type Signal =
  /** The session this process is now talking to. Emitted at the start of every turn. */
  | { kind: "session"; sessionId: string; model: string | undefined; permissionMode: string | undefined; tools: string[] }
  /** A finished block of prose from the model. This is what gets posted to the thread. */
  | { kind: "text"; text: string; fromSubagent: boolean }
  /** Extended thinking. Logged, never posted. */
  | { kind: "thinking"; chars: number; fromSubagent: boolean }
  | { kind: "tool-start"; tool: ToolRef; fromSubagent: boolean }
  | { kind: "tool-end"; toolUseId: string; isError: boolean; summary: string; fromSubagent: boolean }
  /**
   * The turn has stopped and needs a person: a gated tool, or a question the
   * model asked with `AskUserQuestion`. Answering it is what lets the turn
   * continue, so nothing else happens until this is settled.
   */
  | {
      kind: "ask";
      requestId: string;
      tool: ToolRef;
      /** True for a tool whose own card is the interaction, i.e. `AskUserQuestion`. */
      isQuestion: boolean;
      title: string | undefined;
      description: string | undefined;
      /** Why the ask escalated, when the CLI explains it. May carry ANSI escapes. */
      reason: string | undefined;
    }
  /** An ask this program parked is no longer wanted, e.g. the turn was interrupted. */
  | { kind: "ask-withdrawn"; requestId: string }
  /**
   * A gated tool the CLI refused on its own, without asking. Only happens when
   * asks are not routed here, which this program does not do; kept because it is
   * the shape a mis-set `--permission-mode` produces.
   */
  | { kind: "auto-denied"; toolName: string; toolUseId: string; message: string }
  /** The reply to a control request this program sent. */
  | { kind: "control-reply"; requestId: string; ok: boolean; payload: Record<string, unknown>; error: string | undefined }
  /** The turn is over. */
  | {
      kind: "turn-end";
      ok: boolean;
      /** The model's last words, as the CLI reports them. A fallback for `text`. */
      text: string;
      error: string | undefined;
      denials: Denial[];
      costUsd: number | undefined;
      durationMs: number | undefined;
      /** Turns the model took. Zero means the CLI never called it. */
      modelTurns: number | undefined;
    }
  /**
   * A compaction has finished: the history was summarized in place, or it could
   * not be. Both the `/compact` this program sends and the one the CLI runs on
   * its own when a session fills up end here.
   */
  | {
      kind: "compacted";
      ok: boolean;
      error: string | undefined;
      /** What the history measured before and after. Absent when the CLI did not say. */
      preTokens: number | undefined;
      postTokens: number | undefined;
    }
  /** Anything worth a log line but not a decision: rate limits, status ticks, API retries. */
  | { kind: "notice"; level: "debug" | "info" | "warn"; text: string; fields: Record<string, unknown> }
  /** Recognized, and deliberately of no interest. */
  | { kind: "ignored"; why: string }
  /** No rule claimed it. Logged loudly, because it means the patterns need updating. */
  | { kind: "unrecognized"; event: RawEvent };
