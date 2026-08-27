import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Logger } from "./logger.ts";
import { recognize, type Rule } from "./patterns.ts";
import type { RawEvent, Signal } from "./signals.ts";

/** The answer to a `can_use_tool` ask, in the shape the CLI's control protocol expects. */
export type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

export type ClaudeOptions = {
  /** Program to run. An absolute path when `claude` may not be on the forwarder's PATH. */
  binary: string;
  cwd: string;
  model: string | undefined;
  effort: string | undefined;
  permissionMode: string | undefined;
  allowedTools: string | undefined;
  disallowedTools: string | undefined;
  addDirs: string[];
  /**
   * Whether a resumed session is copied rather than carried on, which is what a
   * thread does with a session belonging to the thread it came out of.
   */
  forkSession: boolean;
  appendSystemPrompt: string | undefined;
  /** Passed through to `claude` untouched, for flags this program has no opinion about. */
  extraArgs: string[];
  rules: Rule[];
  /** Where to append every raw event, for working out why a pattern stopped matching. */
  recordPath: string | undefined;
  log: Logger;
  onSignal(signal: Signal): void;
  /** Called whenever the child goes away, expected or not. */
  onExit(code: number | null, signal: NodeJS.Signals | null): void;
};

export type Claude = {
  readonly running: boolean;
  /** The session the CLI is using, learned from its first `system/init`. */
  readonly sessionId: string | undefined;
  /** Starts the child, resuming `sessionId` when one is given. Resolves once it is ready for messages. */
  start(sessionId: string | undefined): Promise<void>;
  /** Queues one user message. The CLI runs it as a turn. */
  send(text: string): void;
  /** Settles a parked `can_use_tool` ask. */
  answer(requestId: string, result: PermissionResult): void;
  interrupt(): Promise<void>;
  /** SIGTERMs the child and waits for it, then gives up and SIGKILLs. */
  stop(): Promise<void>;
};

/** How long `stop` waits for a SIGTERMed child before killing it outright. */
const STOP_GRACE_MS = 5000;

/** How long `start` waits for the CLI to answer `initialize` before running without it. */
const INITIALIZE_TIMEOUT_MS = 30000;

/**
 * A parked ask is answered by a person writing a comment, which can take hours.
 * The CLI's own deadline is five minutes, so it is pushed out of the way; this
 * program applies its own, from `--ask-timeout`.
 */
const DIALOG_TIMEOUT_MS = "86400000";

function childEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(process.env["CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS"] === undefined
      ? { CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS: DIALOG_TIMEOUT_MS }
      : {}),
    // Escape codes in an ask's reason would be posted verbatim into a comment.
    ...(process.env["NO_COLOR"] === undefined ? { NO_COLOR: "1" } : {}),
  };
}

/**
 * The argv that puts `claude` on the wire this program speaks.
 *
 * The first six are what make the protocol work at all: `--print` with
 * stream-json both ways gives one JSON object per line in each direction, and
 * `--permission-prompt-tool stdio` is what routes a permission prompt here as a
 * `can_use_tool` control request instead of the CLI refusing it on its own.
 */
function buildArgs(options: ClaudeOptions, sessionId: string | undefined): string[] {
  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-prompt-tool",
    "stdio",
  ];

  // `--resume` takes an optional value, so it has to be joined with `=` to bind.
  if (sessionId !== undefined) args.push(`--resume=${sessionId}`);
  // Only ever alongside a resume: on its own it is a flag about nothing.
  if (sessionId !== undefined && options.forkSession) args.push("--fork-session");
  if (options.model !== undefined) args.push("--model", options.model);
  if (options.effort !== undefined) args.push("--effort", options.effort);
  if (options.permissionMode !== undefined) args.push("--permission-mode", options.permissionMode);
  if (options.allowedTools !== undefined) args.push("--allowed-tools", options.allowedTools);
  if (options.disallowedTools !== undefined) args.push("--disallowed-tools", options.disallowedTools);
  for (const directory of options.addDirs) args.push("--add-dir", directory);
  if (options.appendSystemPrompt !== undefined) args.push("--append-system-prompt", options.appendSystemPrompt);
  args.push(...options.extraArgs);

  return args;
}

export function createClaude(options: ClaudeOptions): Claude {
  const { log } = options;

  let child: ChildProcess | undefined;
  let sessionId: string | undefined;
  let nextRequest = 0;
  const pending = new Map<string, (payload: { ok: boolean; error: string | undefined }) => void>();

  function write(frame: unknown): void {
    const stdin = child?.stdin;
    if (stdin === undefined || stdin === null || !stdin.writable) {
      log.warn("dropping a frame: the claude process is not accepting input", { frame: JSON.stringify(frame).slice(0, 200) });
      return;
    }
    stdin.write(`${JSON.stringify(frame)}\n`);
  }

  function controlRequest(request: Record<string, unknown>, timeoutMs: number): Promise<void> {
    const requestId = `mfc-${++nextRequest}`;
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!pending.delete(requestId)) return;
        log.warn("no answer to a control request", { subtype: request["subtype"], requestId });
        resolve();
      }, timeoutMs);
      timer.unref();

      pending.set(requestId, ({ ok, error }) => {
        clearTimeout(timer);
        if (!ok) log.warn("a control request was refused", { subtype: request["subtype"], error });
        resolve();
      });

      write({ type: "control_request", request_id: requestId, request });
    });
  }

  function handleLine(line: string): void {
    if (line.trim() === "") return;
    if (options.recordPath !== undefined) {
      try {
        appendFileSync(options.recordPath, `${line}\n`);
      } catch (error) {
        log.warn("could not record an event", { error: (error as Error).message });
      }
    }

    let event: RawEvent;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
      event = parsed as RawEvent;
    } catch (error) {
      // The CLI is not supposed to print anything else on stdout, so this is
      // either a crash trace or a version that no longer speaks stream-json.
      log.warn("claude printed something that is not an event", { error: (error as Error).message, line: line.slice(0, 300) });
      return;
    }

    for (const signal of recognize(event, options.rules)) {
      if (signal.kind === "session") sessionId = signal.sessionId;
      if (signal.kind === "control-reply") {
        const settle = pending.get(signal.requestId);
        if (settle !== undefined) {
          pending.delete(signal.requestId);
          settle({ ok: signal.ok, error: signal.error });
          continue;
        }
      }
      options.onSignal(signal);
    }
  }

  return {
    get running() {
      return child !== undefined && child.exitCode === null && child.signalCode === null;
    },

    get sessionId() {
      return sessionId;
    },

    async start(resume) {
      if (child !== undefined) throw new Error("this claude process is already running");
      sessionId = resume;

      const args = buildArgs(options, resume);
      log.info("starting claude", { binary: options.binary, cwd: options.cwd, args, resume: resume ?? "a new session" });

      const started = spawn(options.binary, args, {
        cwd: options.cwd,
        env: childEnvironment(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      child = started;

      started.on("error", (error: NodeJS.ErrnoException) => {
        const hint = error.code === "ENOENT" ? ` - is "${options.binary}" installed and on PATH?` : "";
        log.error(`claude failed to start: ${error.message}${hint}`);
      });

      // Expected whenever the child leaves while a turn is still being written to it.
      started.stdin?.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") log.warn("could not write to claude", { error: error.message });
      });

      if (started.stdout !== null) {
        createInterface({ input: started.stdout, crlfDelay: Number.POSITIVE_INFINITY }).on("line", handleLine);
      }
      if (started.stderr !== null) {
        createInterface({ input: started.stderr, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
          if (line.trim() !== "") log.warn("claude stderr", { line });
        });
      }

      started.on("close", (code, signal) => {
        for (const settle of pending.values()) settle({ ok: false, error: "the claude process ended" });
        pending.clear();
        if (child === started) child = undefined;
        options.onExit(code, signal);
      });

      // Sent for the same reason the Agent SDK sends it: without it the CLI runs
      // in a reduced mode where AskUserQuestion is not offered to the model.
      await controlRequest({ subtype: "initialize" }, INITIALIZE_TIMEOUT_MS);
    },

    send(text) {
      write({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
    },

    answer(requestId, result) {
      write({ type: "control_response", response: { subtype: "success", request_id: requestId, response: result } });
    },

    interrupt() {
      return controlRequest({ subtype: "interrupt", cancel_queued: true }, STOP_GRACE_MS);
    },

    stop() {
      const running = child;
      if (running === undefined) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          log.warn("claude did not stop; killing it");
          running.kill("SIGKILL");
        }, STOP_GRACE_MS);
        timer.unref();

        running.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        running.stdin?.end();
        running.kill("SIGTERM");
      });
    },
  };
}
