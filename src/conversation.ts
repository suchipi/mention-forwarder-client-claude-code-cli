import { type Claude, createClaude, type PermissionResult } from "./claude.ts";
import { isApproval } from "./answer.ts";
import { type Directive, type Parsed, parseDirective } from "./directive.ts";
import type { Logger } from "./logger.ts";
import * as say from "./message.ts";
import type { Mention } from "./mention.ts";
import type { Options } from "./options.ts";
import type { Rule } from "./patterns.ts";
import type { Reply } from "./reply.ts";
import type { SessionStore } from "./session-store.ts";
import type { Signal } from "./signals.ts";

type Ask = Extract<Signal, { kind: "ask" }>;

/** A turn the CLI is running, and where its output goes. */
type Turn = {
  mention: Mention;
  /** Whether anything at all has been posted for this turn. */
  posted: boolean;
  /** Whether the model's own prose has been posted, which decides the end-of-turn fallback. */
  postedText: boolean;
  /** Set when somebody in the thread called this turn off, so its abrupt end is not reported as a failure. */
  interrupted: boolean;
};

/** An ask waiting for somebody to answer it in the thread. */
type Parked = {
  ask: Ask;
  timer: NodeJS.Timeout | undefined;
};

export type Conversation = {
  handle(mention: Mention): Promise<void>;
  /**
   * Waits for every mention handed over so far to finish. No more can arrive
   * after this is called, so anything waiting on a person is refused rather than
   * left to hang: it is how a `per-mention` run, whose stdin closes at once,
   * still gets to run its turn to the end.
   */
  finish(): Promise<void>;
  /** Settles anything outstanding and ends the `claude` process. */
  stop(): Promise<void>;
};

export type ConversationDeps = {
  options: Options;
  rules: Rule[];
  store: SessionStore;
  reply: Reply;
  log: Logger;
};

/** How long after a start a non-zero exit is read as "it never got going". */
const STARTUP_WINDOW_MS = 15000;

/**
 * The mention again with the interrupt word spent, so anything else the group
 * carried still runs as a turn of its own. The settings are written back out
 * rather than applied here, because a turn is what applies them.
 */
function afterInterrupt(mention: Mention, parsed: Parsed): Mention | undefined {
  const group: string[] = [];
  if (parsed.directive.model !== undefined) group.push(`model=${parsed.directive.model}`);
  if (parsed.directive.effort !== undefined) group.push(`effort=${parsed.directive.effort}`);
  const text = (group.length === 0 ? parsed.rest : `[${group.join(", ")}] ${parsed.rest}`).trim();
  return text === "" ? undefined : { ...mention, text, prompt: text };
}

export function createConversation({ options, rules, store, reply, log }: ConversationDeps): Conversation {
  let claude: Claude | undefined;
  let sessionId: string | undefined;
  let conversationKey: string | undefined;
  let settings: Directive = { model: options.model, effort: options.effort };

  let turn: Turn | undefined;
  let parked: Parked | undefined;
  const waiting: Mention[] = [];
  /** Set while `stop` is running, so a child that exits then is not reported as a crash. */
  let stopping = false;
  let startedAt = 0;
  /** Set when a resumed session failed to open, so the retry does not loop. */
  let resumeFailed = false;
  /** Set once no further mentions can arrive, which is what makes a parked ask unanswerable. */
  let inputEnded = false;
  let settledWaiters: (() => void)[] = [];

  function settled(): boolean {
    return turn === undefined && parked === undefined && waiting.length === 0;
  }

  function checkSettled(): void {
    if (!settled()) return;
    const waiters = settledWaiters;
    settledWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function post(text: string, isModelProse = false): void {
    if (turn === undefined) {
      log.warn("nowhere to post this; no turn is running", { text: text.slice(0, 120) });
      return;
    }
    reply.append(turn.mention.replyFile, text);
    turn.posted = true;
    if (isModelProse) turn.postedText = true;
  }

  function remember(): void {
    if (conversationKey === undefined) return;
    // Written even without a session id: a group on its own settles the thread's
    // settings and then runs nothing, so this is the only chance to keep them.
    store.set(conversationKey, { sessionId, cwd: options.cwd, model: settings.model, effort: settings.effort });
  }

  // --- answering an ask ---

  function settle(ask: Ask, result: PermissionResult): void {
    if (parked?.ask.requestId === ask.requestId) {
      if (parked.timer !== undefined) clearTimeout(parked.timer);
      parked = undefined;
    }
    claude?.answer(ask.requestId, result);
    log.info("answered an ask", { tool: ask.tool.name, behavior: result.behavior });
    checkSettled();
  }

  function park(ask: Ask): void {
    post(say.askNotice(ask));
    const timer =
      options.askTimeoutMs > 0
        ? setTimeout(() => {
            log.warn("nobody answered in time", { tool: ask.tool.name, afterMs: options.askTimeoutMs });
            settle(ask, { behavior: "deny", message: say.askTimedOut() });
          }, options.askTimeoutMs)
        : undefined;
    timer?.unref();
    parked = { ask, timer };
    log.info("waiting for a person", { tool: ask.tool.name, requestId: ask.requestId });
  }

  function onAsk(ask: Ask): void {
    // A question has no answer to auto-supply, so it is refused with an
    // explanation whenever there is nobody being asked.
    if (ask.isQuestion && options.approval !== "ask") {
      settle(ask, { behavior: "deny", message: say.nobodyToAsk() });
      return;
    }
    if (options.approval === "allow") {
      settle(ask, { behavior: "allow", updatedInput: ask.tool.input });
      return;
    }
    if (options.approval === "deny") {
      settle(ask, { behavior: "deny", message: say.refusedByPolicy(ask.tool.name) });
      return;
    }
    if (inputEnded) {
      settle(ask, { behavior: "deny", message: say.noMoreAnswers() });
      return;
    }
    if (parked !== undefined) {
      // Only one ask can be outstanding, since only the next comment can answer it.
      log.warn("refusing an ask while another is waiting", { tool: ask.tool.name });
      settle(ask, {
        behavior: "deny",
        message: "Something else is already waiting on a person here. Ask again once that is settled.",
      });
      return;
    }
    park(ask);
  }

  /** Answers the parked ask with what a person just wrote, and moves the turn's output to their comment. */
  function answerWith(mention: Mention, body: string): void {
    const ask = parked?.ask;
    if (ask === undefined) return;
    if (turn !== undefined) turn.mention = mention;

    if (ask.isQuestion) {
      settle(ask, { behavior: "deny", message: say.answerToQuestion(body) });
      return;
    }
    if (isApproval(body)) {
      settle(ask, { behavior: "allow", updatedInput: ask.tool.input });
      return;
    }
    settle(ask, { behavior: "deny", message: body.trim() === "" ? "The person did not approve it." : body.trim() });
  }

  // --- the signal stream ---

  function onSignal(signal: Signal): void {
    switch (signal.kind) {
      case "session": {
        if (sessionId !== signal.sessionId) {
          sessionId = signal.sessionId;
          remember();
        }
        log.debug("session", { sessionId: signal.sessionId, model: signal.model, permissionMode: signal.permissionMode });
        break;
      }

      case "text": {
        if (signal.fromSubagent) {
          log.debug("subagent said something", { chars: signal.text.length });
          break;
        }
        log.info("agent", { text: signal.text });
        if (options.progress === "all") post(signal.text, true);
        break;
      }

      case "thinking":
        log.debug("thinking", { chars: signal.chars, subagent: signal.fromSubagent });
        break;

      case "tool-start":
        log.info("tool", { name: signal.tool.name, input: signal.tool.input, subagent: signal.fromSubagent });
        break;

      case "tool-end":
        log.debug("tool finished", { toolUseId: signal.toolUseId, error: signal.isError, summary: signal.summary });
        break;

      case "ask":
        onAsk(signal);
        break;

      case "ask-withdrawn": {
        if (parked?.ask.requestId !== signal.requestId) break;
        if (parked.timer !== undefined) clearTimeout(parked.timer);
        parked = undefined;
        log.warn("an ask was withdrawn before anyone answered", { requestId: signal.requestId });
        // An interrupt withdraws it on purpose, and says so itself once the turn ends.
        if (turn?.interrupted !== true) post("That request is no longer waiting on an answer.");
        break;
      }

      case "auto-denied":
        log.warn("the CLI refused a tool without asking", { tool: signal.toolName, message: signal.message });
        break;

      case "control-reply":
        log.debug("control reply", { requestId: signal.requestId, ok: signal.ok, error: signal.error });
        break;

      case "turn-end":
        finishTurn(signal);
        break;

      case "notice":
        log[signal.level](signal.text, signal.fields);
        break;

      case "ignored":
        log.debug("ignored an event", { why: signal.why });
        break;

      case "unrecognized":
        // A claude release changed a shape this program reads: see the "Pattern
        // detection" section of the README for what to do about it.
        log.warn("no pattern matched an event", { event: JSON.stringify(signal.event).slice(0, 400) });
        break;
    }
  }

  function finishTurn(end: Extract<Signal, { kind: "turn-end" }>): void {
    const finished = turn;
    if (finished === undefined) {
      log.warn("a turn ended that this program did not start");
      return;
    }

    if (parked !== undefined) {
      // The CLI gave up on the ask on its way out; nothing left to answer it with.
      if (parked.timer !== undefined) clearTimeout(parked.timer);
      parked = undefined;
    }

    if (finished.interrupted) {
      post(say.interruptedNotice());
    } else if (!end.ok) {
      const detail = end.error ?? "no reason given";
      // The CLI reports some failures as prose from the model as well as on the
      // result, and the thread should not be told the same thing twice.
      if (!finished.postedText || detail.trim() !== end.text.trim()) post(say.failureNotice(detail));
    } else if (!finished.postedText && end.text.trim() !== "") {
      // Either --progress final, or the model's words never arrived as their own
      // event. Either way this is the same text, so it cannot double up.
      post(end.text, true);
    }

    if (end.denials.length > 0 && options.approval === "deny") post(say.denialNotice(end.denials));

    log.info("turn finished", {
      ok: end.ok,
      costUsd: end.costUsd,
      durationMs: end.durationMs,
      posted: finished.posted,
      denials: end.denials.length,
    });

    turn = undefined;
    remember();
    drain();
  }

  // --- the claude process ---

  function onExit(code: number | null, signal: NodeJS.Signals | null): void {
    claude = undefined;
    if (parked !== undefined) {
      if (parked.timer !== undefined) clearTimeout(parked.timer);
      parked = undefined;
    }
    if (stopping) return;

    const quick = Date.now() - startedAt < STARTUP_WINDOW_MS;
    log.warn("the claude process ended", { code, signal, duringTurn: turn !== undefined });

    if (turn !== undefined) {
      const detail = `claude exited (code ${code ?? "none"}, signal ${signal ?? "none"})`;
      post(quick && sessionId === undefined ? say.startupFailureNotice(detail) : say.failureNotice(detail));
      turn = undefined;
    }
    // Started again by the next mention, so a crash costs one turn and not the thread.
    drain();
  }

  async function ensureRunning(): Promise<boolean> {
    if (claude?.running === true) return true;

    const resume = resumeFailed ? undefined : sessionId;
    startedAt = Date.now();
    const started = createClaude({
      binary: options.binary,
      cwd: options.cwd,
      model: settings.model,
      effort: settings.effort,
      permissionMode: options.permissionMode,
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
      addDirs: options.addDirs,
      appendSystemPrompt: say.systemPrompt(options.approval),
      extraArgs: options.extraArgs,
      rules,
      recordPath: options.recordPath,
      log,
      onSignal,
      onExit,
    });
    claude = started;
    await started.start(resume);

    if (!started.running) {
      claude = undefined;
      // A session id that no longer opens is worth exactly one retry without it,
      // since the alternative is a thread that can never run again.
      if (resume !== undefined && !resumeFailed) {
        log.warn("could not resume the remembered session; starting a new one", { sessionId: resume });
        resumeFailed = true;
        sessionId = undefined;
        if (conversationKey !== undefined) store.forget(conversationKey);
        return ensureRunning();
      }
      return false;
    }
    return true;
  }

  /** Restarts on the same session, which is how a changed model or effort takes hold. */
  async function restart(): Promise<void> {
    if (claude === undefined) return;
    stopping = true;
    await claude.stop();
    stopping = false;
    claude = undefined;
  }

  // --- running mentions ---

  /** Posts one line for a mention that never becomes a turn, e.g. a settings change. */
  function reportTo(mention: Mention, text: string): void {
    turn = { mention, posted: false, postedText: false, interrupted: false };
    post(text);
    turn = undefined;
  }

  /**
   * Calls the running turn off. Nothing here clears the turn: the CLI withdraws
   * whatever it was waiting on, ends the turn itself, and `finishTurn` is what
   * settles it, which is what keeps that end from landing on a later turn.
   */
  async function interruptTurn(mention: Mention): Promise<void> {
    const running = turn;
    if (claude === undefined || running === undefined) {
      log.info("nothing to interrupt", { id: mention.id });
      reportTo(mention, say.nothingToInterrupt());
      return;
    }

    // What is left of this turn belongs to whoever called it off, not to the comment that started it.
    running.mention = mention;
    running.interrupted = true;
    log.info("interrupting the running turn", { id: mention.id, parked: parked !== undefined });
    await claude.interrupt();
  }

  async function run(mention: Mention, body: string): Promise<void> {
    if (!(await ensureRunning())) {
      // An exit during startup is reported by onExit only once a turn is open,
      // which it is not yet, so this is the one place that says so.
      reportTo(mention, say.startupFailureNotice("it exited before it was ready; its output is in this command's log"));
      drain();
      return;
    }

    // Read after starting: resuming a session that is gone clears it, and the
    // fresh session that replaces it needs the opening framing.
    const opening = sessionId === undefined;
    turn = { mention, posted: false, postedText: false, interrupted: false };

    const text = opening ? say.firstMessage(mention, body) : say.followUpMessage(mention, body);
    log.info("running a mention", { id: mention.id, url: mention.url, opening, chars: text.length });
    claude?.send(text);
  }

  function drain(): void {
    if (turn !== undefined || parked !== undefined) return;
    const next = waiting.shift();
    if (next === undefined) {
      checkSettled();
      return;
    }
    start(next).catch((error: unknown) => {
      log.error("could not start a queued mention", {
        id: next.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async function start(mention: Mention): Promise<void> {
    conversationKey ??= mention.conversationKey;

    const { directive, rest, problem } = parseDirective(say.spokenText(mention));
    if (problem !== undefined) {
      reportTo(mention, problem);
      drain();
      return;
    }

    if (directive.model !== undefined || directive.effort !== undefined) {
      settings = { model: directive.model ?? settings.model, effort: directive.effort ?? settings.effort };
      remember();
      // Model and effort are start-up flags, so the change lands on a restart.
      // The session id is kept, so the thread keeps its history.
      await restart();
      log.info("thread settings changed", { model: settings.model, effort: settings.effort });

      if (rest === "") {
        reportTo(mention, say.directiveNotice(directive, settings));
        drain();
        return;
      }
    }

    await run(mention, rest);
  }

  return {
    async handle(mention) {
      conversationKey ??= mention.conversationKey;
      if (conversationKey !== mention.conversationKey) {
        // per-conversation gives one process per thread; anything else is a misconfiguration.
        log.warn("a mention from another conversation arrived", { expected: conversationKey, got: mention.conversationKey });
      }

      const remembered = store.get(mention.conversationKey);
      if (sessionId === undefined && remembered !== undefined) {
        sessionId = remembered.sessionId;
        settings = {
          model: remembered.model ?? settings.model,
          effort: remembered.effort ?? settings.effort,
        };
        log.info("picking a thread back up", { sessionId, model: settings.model, effort: settings.effort });
      }

      // Read before the two branches below, because stopping a turn is the one
      // thing a person needs to be able to say while it is running or waiting.
      const parsed = parseDirective(say.spokenText(mention));
      if (parsed.directive.interrupt === true) {
        await interruptTurn(mention);
        const next = afterInterrupt(mention, parsed);
        if (next !== undefined) waiting.push(next);
        drain();
        return;
      }

      if (parked !== undefined) {
        log.info("this mention answers what the agent was waiting on", { id: mention.id });
        answerWith(mention, say.spokenText(mention));
        return;
      }

      if (turn !== undefined) {
        log.info("queued behind the running turn", { id: mention.id, waiting: waiting.length + 1 });
        waiting.push(mention);
        return;
      }

      await start(mention);
    },

    finish() {
      inputEnded = true;
      if (parked !== undefined) {
        log.warn("nothing can answer the waiting request now that input has ended", { tool: parked.ask.tool.name });
        settle(parked.ask, { behavior: "deny", message: say.noMoreAnswers() });
      }
      if (settled()) return Promise.resolve();
      return new Promise<void>((resolve) => settledWaiters.push(resolve));
    },

    async stop() {
      stopping = true;
      if (parked !== undefined) {
        settle(parked.ask, { behavior: "deny", message: "The bot is shutting down, so this was not approved." });
      }
      if (claude !== undefined) {
        if (turn !== undefined) await claude.interrupt();
        await claude.stop();
      }
      claude = undefined;
      turn = undefined;
    },
  };
}
