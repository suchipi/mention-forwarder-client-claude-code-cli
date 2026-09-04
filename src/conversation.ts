import { type Claude, createClaude, type PermissionResult } from "./claude.ts";
import { isApproval } from "./answer.ts";
import { type Parsed, parseDirective } from "./directive.ts";
import type { ForkRequest, ForkStore } from "./fork-store.ts";
import type { Logger } from "./logger.ts";
import * as say from "./message.ts";
import type { Mention } from "./mention.ts";
import { applyThreadSettings, type Options } from "./options.ts";
import type { Rule } from "./patterns.ts";
import type { Reply } from "./reply.ts";
import type { Remembered, SessionStore } from "./session-store.ts";
import {
  hasSettings,
  restartsClaude,
  settingsToGroup,
  type ThreadSettings,
} from "./settings.ts";
import type { Signal } from "./signals.ts";

type Ask = Extract<Signal, { kind: "ask" }>;
type Compacted = Extract<Signal, { kind: "compacted" }>;

/** A turn the CLI is running, and where its output goes. */
type Turn = {
  mention: Mention;
  startedAt: string;
  /** Whether anything at all has been posted for this turn. */
  posted: boolean;
  /** Whether the model's own prose has been posted, which decides the end-of-turn fallback. */
  postedText: boolean;
  /** Prose `--progress final` is keeping back, until either the turn ends or it stops to ask. */
  held: string[];
  /** The last prose an ask let out early, so the end-of-turn fallback does not say it twice. */
  flushed: string | undefined;
  /** Set when somebody in the thread called this turn off, so its abrupt end is not reported as a failure. */
  interrupted: boolean;
  /** How many mentions reached this turn while it was already running. Logged; nothing branches on it. */
  steers: number;
  /** Whether this turn is a `/compact`, which the model never sees and never answers. */
  compacting: boolean;
  /** How that compaction went, as the CLI reported it on the way to ending the turn. */
  compacted: Compacted | undefined;
};

/** An ask waiting for somebody to answer it in the thread. */
type Parked = {
  ask: Ask;
  since: string;
  timer: NodeJS.Timeout | undefined;
};

/** The thread a conversation belongs to, as the mention that last reached it described it. */
export type Thread = {
  platform: string;
  /** Issue or PR title, or the Slack channel id. Empty when the platform offers none. */
  title: string;
  /** Permalink to the comment or message that did the mentioning. */
  url: string;
  author: string;
  receivedAt: string;
};

/**
 * What this process is doing right now, for the web view to publish. Read-only by
 * construction: nothing in the state machine branches on it.
 */
export type ConversationSnapshot = {
  conversationKey: string | undefined;
  cwd: string;
  sessionId: string | undefined;
  model: string | undefined;
  effort: string | undefined;
  state: "idle" | "running" | "waiting";
  thread: Thread | undefined;
  turn: { startedAt: string; url: string; author: string; steers: number } | undefined;
  parked: { tool: string; isQuestion: boolean; since: string } | undefined;
  /** Mentions waiting for a turn of their own. */
  queued: number;
  /** Mentions this process has taken in, however each was spent. */
  mentions: number;
  /** Turns it has run to the end. */
  turns: number;
};

/** What a thread splitting off another one starts from: the session it is on, and the settings it is on. */
export type ForkPoint = {
  sessionId: string | undefined;
  settings: ThreadSettings;
};

/** The thread a conversation was split off, and where that thread had got to. */
export type SplitFrom = { request: ForkRequest; point: ForkPoint };

export type Conversation = {
  handle(mention: Mention): Promise<void>;
  /**
   * Where a thread splitting off this one starts. Settles this thread's own
   * session first: one that has not run in this process yet keeps its session in
   * the store rather than in hand, and splitting off nothing would hand the new
   * thread a blank where the work is.
   */
  forkPoint(mention: Mention): ForkPoint;
  /** What the process is doing right now. Nothing reads this but the web view. */
  snapshot(): ConversationSnapshot;
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
  forks: ForkStore;
  reply: Reply;
  log: Logger;
  /**
   * What this conversation is remembered as, when that is not simply the thread
   * its mentions arrive under: every review comment on a pull request arrives
   * under that pull request's key, so a review thread given a session of its own
   * needs a key of its own to be remembered by.
   */
  key?: string;
  /**
   * The thread this one was split off, for a conversation made on the spot
   * rather than found in the store. The store is not asked for the parent here,
   * because the thread it splits is running in this process and its session is
   * newer in hand than on disk.
   */
  splitFrom?: SplitFrom;
};

/** How long after a start a non-zero exit is read as "it never got going". */
const STARTUP_WINDOW_MS = 15000;

/**
 * The mention again with the word that did something spent, so anything else the
 * group carried still runs as a turn of its own. The settings are written back
 * out rather than applied here, because a turn is what applies them.
 */
export function afterDirective(mention: Mention, parsed: Parsed): Mention | undefined {
  const group = settingsToGroup(parsed.directive.settings);
  // Not spent by the word that ran: `[exit, clear]` ends the process and still
  // has a history to throw away afterwards.
  if (parsed.directive.clear === true) group.push("clear");
  if (parsed.directive.compact === true) group.push("compact");
  const text = (
    group.length === 0 ? parsed.rest : `[${group.join(", ")}] ${parsed.rest}`
  ).trim();
  return text === "" ? undefined : { ...mention, text, prompt: text };
}

export function createConversation({
  options,
  rules,
  store,
  forks,
  reply,
  log,
  key,
  splitFrom,
}: ConversationDeps): Conversation {
  let claude: Claude | undefined;
  let sessionId: string | undefined;
  let conversationKey: string | undefined;
  /** What a group in this thread has put it on, over what the process was started on. */
  let settings: ThreadSettings = {};
  /** Those two settled, so nothing downstream has to know a thread can differ from its process. */
  let current: Options = options;

  let turn: Turn | undefined;
  let parked: Parked | undefined;
  const waiting: Mention[] = [];
  /** The mention that most recently reached this process, which is what names the thread. */
  let thread: Thread | undefined;
  let mentions = 0;
  let turns = 0;
  /** Set while `stop` is running, so a child that exits then is not reported as a crash. */
  let stopping = false;
  let startedAt = 0;
  /** Set when a resumed session failed to open, so the retry does not loop. */
  let resumeFailed = false;
  /** Set while the session id held here is another thread's, so the next start copies it rather than joining it. */
  let forkParent = false;
  /** Set once this thread has thrown its history away, which is also a refusal of anybody else's. */
  let cleared = false;
  /**
   * The thread whose history this one opens with, until the message that says so
   * has been sent. `split` tells the two ways that happens apart: a thread that
   * came out of this work, and a review thread that was cut out of it.
   */
  let carriedFrom: { request: ForkRequest; split: boolean } | undefined;
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
      log.warn("nowhere to post this; no turn is running", {
        text: text.slice(0, 120),
      });
      return;
    }
    reply.append(turn.mention.replyFile, text);
    turn.posted = true;
    if (isModelProse) turn.postedText = true;
  }

  /** What this conversation is filed under, which is its own key when it was split off another thread. */
  function ownKey(): string | undefined {
    return key ?? conversationKey;
  }

  function remember(): void {
    const mine = ownKey();
    if (mine === undefined) return;
    // Written even without a session id: a group on its own settles the thread's
    // settings and then runs nothing, so this is the only chance to keep them.
    store.set(mine, {
      // A session id borrowed for a fork is not this thread's to keep. Kept, the
      // next process would read it back and resume it rather than fork it, and
      // both threads would be writing their turns into one history.
      sessionId: forkParent ? undefined : sessionId,
      cwd: current.cwd,
      settings: hasSettings(settings) ? settings : undefined,
      // Left out until it is true, so the file says nothing about the threads
      // that never cleared, which is nearly all of them.
      cleared: cleared ? true : undefined,
    });
  }

  /**
   * Puts the thread on the settings a group asked for, over whatever it was on.
   *
   * Says whether anything changed, so a group that carried none is not answered
   * as though it had. Restarting `claude` is the caller's to do: only it knows
   * whether the turn those settings belong to has started yet.
   */
  function takeOn(next: ThreadSettings): boolean {
    if (!hasSettings(next)) return false;
    settings = { ...settings, ...next };
    current = applyThreadSettings(options, settings);
    // A thread that has just asked to see the work should not have to wait for
    // the end of the turn to see the part of it that has already happened.
    if (current.progress === "all") releaseHeldProse();
    remember();
    log.info("thread settings changed", { settings });
    return true;
  }

  // --- answering an ask ---

  function settle(ask: Ask, result: PermissionResult): void {
    if (parked?.ask.requestId === ask.requestId) {
      if (parked.timer !== undefined) clearTimeout(parked.timer);
      parked = undefined;
    }
    claude?.answer(ask.requestId, result);
    log.info("answered an ask", {
      tool: ask.tool.name,
      behavior: result.behavior,
    });
    checkSettled();
  }

  /**
   * Lets out the prose `--progress final` was keeping back. A turn that stops
   * for a person has to carry the words that led up to it, or the thread is
   * asked to approve something nobody there was ever told about.
   */
  function releaseHeldProse(): void {
    if (turn === undefined || turn.held.length === 0) return;
    const blocks = turn.held;
    turn.held = [];
    // Not counted as the turn's prose — its answer is still to come, and the
    // fallback that posts it reads that flag — but remembered, in case these
    // turn out to have been its last words after all.
    turn.flushed = blocks.at(-1)?.trim();
    for (const block of blocks) post(block);
  }

  function park(ask: Ask): void {
    releaseHeldProse();
    post(say.askNotice(ask));
    const timer =
      current.askTimeoutMs > 0
        ? setTimeout(() => {
            log.warn("nobody answered in time", {
              tool: ask.tool.name,
              afterMs: current.askTimeoutMs,
            });
            settle(ask, { behavior: "deny", message: say.askTimedOut() });
          }, current.askTimeoutMs)
        : undefined;
    timer?.unref();
    parked = { ask, since: new Date().toISOString(), timer };
    log.info("waiting for a person", {
      tool: ask.tool.name,
      requestId: ask.requestId,
    });
  }

  function onAsk(ask: Ask): void {
    // A question cannot be approved into an answer the way a tool can, so the
    // only mode that refuses one outright is the one that talks to nobody.
    if (ask.isQuestion && current.approval === "deny") {
      settle(ask, { behavior: "deny", message: say.nobodyToAsk() });
      return;
    }
    if (current.approval === "allow" && !ask.isQuestion) {
      settle(ask, { behavior: "allow", updatedInput: ask.tool.input });
      return;
    }
    if (current.approval === "deny") {
      settle(ask, {
        behavior: "deny",
        message: say.refusedByPolicy(ask.tool.name),
      });
      return;
    }
    if (inputEnded) {
      settle(ask, { behavior: "deny", message: say.noMoreAnswers() });
      return;
    }
    if (parked !== undefined) {
      // Only one ask can be outstanding, since only the next comment can answer it.
      log.warn("refusing an ask while another is waiting", {
        tool: ask.tool.name,
      });
      settle(ask, {
        behavior: "deny",
        message:
          "Something else is already waiting on a person here. Ask again once that is settled.",
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
      settle(ask, {
        behavior: "deny",
        message: say.answerToQuestion(mention, body),
      });
      return;
    }
    if (isApproval(body)) {
      settle(ask, { behavior: "allow", updatedInput: ask.tool.input });
      return;
    }
    settle(ask, {
      behavior: "deny",
      message: say.refusalFrom(mention, body),
    });
  }

  // --- the signal stream ---

  function onSignal(signal: Signal): void {
    switch (signal.kind) {
      case "session": {
        // Cleared before anything is written down, and whether or not the id
        // changed: what the CLI came back with is this thread's own session now,
        // and starting again would otherwise fork the fork.
        forkParent = false;
        if (sessionId !== signal.sessionId) {
          sessionId = signal.sessionId;
          remember();
        }
        log.debug("session", {
          sessionId: signal.sessionId,
          model: signal.model,
          permissionMode: signal.permissionMode,
        });
        break;
      }

      case "text": {
        if (signal.fromSubagent) {
          log.debug("subagent said something", { chars: signal.text.length });
          break;
        }
        log.info("agent", { text: signal.text });
        if (current.progress === "all") post(signal.text, true);
        else if (turn !== undefined) turn.held.push(signal.text);
        break;
      }

      case "thinking":
        log.debug("thinking", {
          chars: signal.chars,
          subagent: signal.fromSubagent,
        });
        break;

      case "tool-start":
        log.info("tool", {
          name: signal.tool.name,
          input: signal.tool.input,
          subagent: signal.fromSubagent,
        });
        break;

      case "tool-end":
        log.debug("tool finished", {
          toolUseId: signal.toolUseId,
          error: signal.isError,
          summary: signal.summary,
        });
        break;

      case "ask":
        onAsk(signal);
        break;

      case "ask-withdrawn": {
        if (parked?.ask.requestId !== signal.requestId) break;
        if (parked.timer !== undefined) clearTimeout(parked.timer);
        parked = undefined;
        log.warn("an ask was withdrawn before anyone answered", {
          requestId: signal.requestId,
        });
        // An interrupt withdraws it on purpose, and says so itself once the turn ends.
        if (turn?.interrupted !== true)
          post("That request is no longer waiting on an answer.");
        break;
      }

      case "auto-denied":
        log.warn("the CLI refused a tool without asking", {
          tool: signal.toolName,
          message: signal.message,
        });
        break;

      case "control-reply":
        log.debug("control reply", {
          requestId: signal.requestId,
          ok: signal.ok,
          error: signal.error,
        });
        break;

      case "compacted":
        log.info(signal.ok ? "the history was compacted" : "the history could not be compacted", {
          error: signal.error,
          preTokens: signal.preTokens,
          postTokens: signal.postTokens,
        });
        // One the CLI ran on its own belongs to whatever turn filled the session
        // up, and that turn has its own answer to give; only one this thread
        // asked for is what its turn is waiting on.
        if (turn?.compacting === true) turn.compacted = signal;
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
        log.warn("no pattern matched an event", {
          event: JSON.stringify(signal.event).slice(0, 400),
        });
        break;
    }
  }

  /**
   * True for a `result` that ends a prompt the CLI queued for itself rather than
   * one this program sent. Resuming a session that left background work behind
   * puts a task notification in front of whatever is sent next, and the CLI
   * closes it without calling the model: no model turn, and nothing to say.
   * Taken for the turn this program started, it strands that turn, which goes on
   * to work, to speak and to stop for permission with nowhere to post any of it.
   * A turn of ours ending this way had nothing to post either, so leaving it open
   * costs the thread nothing, and its own end still closes it.
   */
  function endedAPromptOfItsOwn(
    end: Extract<Signal, { kind: "turn-end" }>,
  ): boolean {
    return (
      end.ok &&
      end.modelTurns === 0 &&
      end.text.trim() === "" &&
      end.denials.length === 0
    );
  }

  function finishTurn(end: Extract<Signal, { kind: "turn-end" }>): void {
    const ownPrompt = endedAPromptOfItsOwn(end);
    if (turn?.compacting === true) {
      // A compaction ends in exactly that shape too, and that end is this
      // thread's: it asked for the compaction, and the turn holding its place
      // closes on it. An end with model work in it, arriving before the
      // compaction has said how it went, is a prompt the CLI had queued for
      // itself running ahead of the command; the compaction is still to come.
      if (!ownPrompt && turn.compacted === undefined) {
        log.debug("ignored a turn end", {
          why: "the CLI answered a prompt of its own while a compaction was pending",
        });
        return;
      }
    } else if (ownPrompt) {
      log.debug("ignored a turn end", {
        why: "the CLI ran a prompt of its own",
      });
      return;
    }

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
    } else if (finished.compacting && end.ok) {
      post(say.compactedNotice(finished.compacted));
    } else if (!end.ok) {
      const detail = end.error ?? "no reason given";
      // The CLI reports some failures as prose from the model as well as on the
      // result, and the thread should not be told the same thing twice.
      if (!finished.postedText || detail.trim() !== end.text.trim())
        post(say.failureNotice(detail));
    } else if (
      !finished.postedText &&
      end.text.trim() !== "" &&
      end.text.trim() !== finished.flushed
    ) {
      // Either --progress final, or the model's words never arrived as their own
      // event. Either way this is the same text, so it cannot double up.
      post(end.text, true);
    }

    if (end.denials.length > 0 && current.approval === "deny")
      post(say.denialNotice(end.denials));

    log.info("turn finished", {
      ok: end.ok,
      costUsd: end.costUsd,
      durationMs: end.durationMs,
      posted: finished.posted,
      denials: end.denials.length,
      steers: finished.steers,
    });

    turn = undefined;
    turns += 1;
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
    log.warn("the claude process ended", {
      code,
      signal,
      duringTurn: turn !== undefined,
    });

    if (turn !== undefined) {
      const detail = `claude exited (code ${code ?? "none"}, signal ${signal ?? "none"})`;
      post(
        quick && sessionId === undefined
          ? say.startupFailureNotice(detail)
          : say.failureNotice(detail),
      );
      turn = undefined;
    }
    // Started again by the next mention, so a crash costs one turn and not the thread.
    drain();
  }

  async function ensureRunning(mention: Mention): Promise<boolean> {
    if (claude?.running === true) return true;

    const resume = resumeFailed ? undefined : sessionId;
    startedAt = Date.now();
    const record =
      forks.path === undefined
        ? undefined
        : { path: forks.path, from: ownKey() ?? mention.conversationKey };
    const started = createClaude({
      binary: current.binary,
      cwd: current.cwd,
      model: current.model,
      effort: current.effort,
      permissionMode: current.permissionMode,
      allowedTools: current.allowedTools,
      disallowedTools: current.disallowedTools,
      // The fork file is given to the agent as its own directory to write in, so
      // recording a pull request is not a permission request posted to a thread.
      addDirs:
        forks.directory === undefined
          ? current.addDirs
          : [...current.addDirs, forks.directory],
      forkSession: forkParent,
      appendSystemPrompt: say.systemPrompt(
        current.approval,
        mention,
        current.appendSystemPrompt,
        record,
        // True for exactly the run that copies another thread's session, which
        // is the run that is about to find itself sharing a directory.
        forkParent,
      ),
      extraArgs: current.extraArgs,
      rules,
      recordPath: current.recordPath,
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
        log.warn(
          "could not resume the remembered session; starting a new one",
          { sessionId: resume },
        );
        resumeFailed = true;
        sessionId = undefined;
        // Whatever this thread was going to carry over is gone with the session
        // that held it, so what starts instead is a thread of its own.
        forkParent = false;
        carriedFrom = undefined;
        const mine = ownKey();
        if (mine !== undefined) store.forget(mine);
        return ensureRunning(mention);
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
    turn = {
      mention,
      startedAt: new Date().toISOString(),
      posted: false,
      postedText: false,
      held: [],
      flushed: undefined,
      interrupted: false,
      steers: 0,
      compacting: false,
      compacted: undefined,
    };
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
    log.info("interrupting the running turn", {
      id: mention.id,
      parked: parked !== undefined,
    });
    await claude.interrupt();
  }

  /**
   * Hands a mention to the turn already running, rather than making it wait for
   * one of its own. The CLI takes a user message written part-way through a turn
   * and folds it in at its next step, which is what makes this possible at all.
   *
   * Nothing comes back from the CLI to say it landed, so the thread is told here,
   * on the way out, rather than when the agent acts on it — unless the turn's own
   * answer is coming to that same thread, which says it better than a notice can.
   */
  function steer(mention: Mention, body: string): void {
    const running = turn;
    if (running === undefined) return;

    running.steers += 1;
    log.info("steering the running turn", {
      id: mention.id,
      steers: running.steers,
    });
    // Only the acknowledgement belongs to whoever steered. Moving the turn's
    // output here as well would post its answer under an unrelated comment,
    // which on GitHub is a different review thread from the one that asked.
    const notice = say.steeredNotice(running.mention, mention);
    if (notice !== undefined) reply.append(mention.replyFile, notice);
    claude?.send(say.steerMessage(mention, body));
  }

  /**
   * Throws the thread's history away, so the next mention opens a session of its
   * own with nothing behind it. The process goes with it: which session it is on
   * is settled when `claude` starts, and the one running is on the session being
   * forgotten. The thread's model and effort are not history, and stay.
   */
  async function forgetHistory(): Promise<void> {
    await restart();
    sessionId = undefined;
    // The id that failed to resume went with the history; the next start is a
    // new session either way, and nothing is left for that flag to describe.
    resumeFailed = false;
    // Whatever this thread came out of is history too, and unwritten history at
    // that: it would otherwise be carried in by the very next mention.
    forkParent = false;
    carriedFrom = undefined;
    cleared = true;
    remember();
  }

  /**
   * Asks Claude Code to summarize the thread's history in place, and holds the
   * turn slot until it says how that went, so anything written after the group
   * runs on what the compaction left rather than beside it.
   *
   * Sent as a message because that is how the CLI takes a slash command over
   * this protocol; there is no control request for one. The process is started
   * for it when the thread has a session but nothing running, since a compaction
   * is exactly what somebody asks for before the next turn rather than after it.
   */
  async function compactHistory(mention: Mention): Promise<void> {
    if (claude?.running !== true) {
      if (sessionId === undefined) {
        log.info("nothing to compact", { id: mention.id });
        reportTo(mention, say.nothingToCompact());
        return;
      }
      if (!(await ensureRunning(mention))) {
        reportTo(
          mention,
          say.startupFailureNotice(
            "it exited before it was ready; its output is in this command's log",
          ),
        );
        return;
      }
    }

    turn = {
      mention,
      startedAt: new Date().toISOString(),
      posted: false,
      postedText: false,
      held: [],
      flushed: undefined,
      interrupted: false,
      steers: 0,
      compacting: true,
      compacted: undefined,
    };
    log.info("compacting the thread's history", { id: mention.id, sessionId });
    claude?.send("/compact");
  }

  /**
   * Ends the process itself, turn and all. The session id is kept, so the next
   * mention starts a process again and picks the thread's history back up.
   */
  async function endProcess(mention: Mention): Promise<void> {
    const running = claude;
    if (running === undefined) {
      log.info("nothing to exit", { id: mention.id });
      reportTo(mention, say.nothingToExit());
      return;
    }

    const hadTurn = turn !== undefined;
    // Dropped before the process goes: a turn-end event on the way out would
    // otherwise post to a turn that is over, and start the next one from here.
    turn = undefined;
    log.info("ending the claude process", {
      id: mention.id,
      hadTurn,
      parked: parked !== undefined,
    });

    stopping = true;
    await running.stop();
    stopping = false;
    claude = undefined;
    // A resume that failed earlier must not stop the replacement resuming: the
    // session id kept here is one that did open.
    resumeFailed = false;

    reportTo(mention, say.exitedNotice(hadTurn));
  }

  async function run(mention: Mention, body: string): Promise<void> {
    if (!(await ensureRunning(mention))) {
      // An exit during startup is reported by onExit only once a turn is open,
      // which it is not yet, so this is the one place that says so.
      reportTo(
        mention,
        say.startupFailureNotice(
          "it exited before it was ready; its output is in this command's log",
        ),
      );
      drain();
      return;
    }

    // Read after starting: resuming a session that is gone clears it, and the
    // fresh session that replaces it needs the opening framing.
    const opening = sessionId === undefined;
    const carried = carriedFrom;
    carriedFrom = undefined;
    turn = {
      mention,
      startedAt: new Date().toISOString(),
      posted: false,
      postedText: false,
      held: [],
      flushed: undefined,
      interrupted: false,
      steers: 0,
      compacting: false,
      compacted: undefined,
    };

    const text =
      carried === undefined
        ? opening
          ? say.firstMessage(mention, body)
          : say.followUpMessage(mention, body)
        : carried.split
          ? say.splitOffMessage(mention, body, ownKey() ?? mention.conversationKey)
          : say.carriedOverMessage(mention, body, carried.request.url);
    log.info("running a mention", {
      id: mention.id,
      url: mention.url,
      opening,
      carriedFrom: carried?.request.from,
      chars: text.length,
    });
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

  /**
   * Takes on the session and the settings of the thread this one came out of.
   *
   * The settings come across with the history, so the new thread is answered by
   * whatever did the work rather than by the defaults. Anything it had already
   * settled for itself stays settled.
   */
  function carryOver(request: ForkRequest, point: ForkPoint, own: Remembered | undefined, split: boolean): void {
    settings = { ...point.settings, ...own?.settings, ...settings };
    current = applyThreadSettings(options, settings);
    if (point.sessionId === undefined) {
      // Nothing to copy: the thread this splits has not run anywhere yet, so this
      // one opens as a thread of its own rather than claiming a history it has not got.
      log.info("the thread this one splits has no session to copy", { from: request.from, url: request.url });
      return;
    }
    sessionId = point.sessionId;
    forkParent = true;
    carriedFrom = { request, split };
    log.info("this thread came out of another one; forking its session", {
      from: request.from,
      url: request.url,
      split,
      sessionId,
      settings,
    });
  }

  /**
   * A thread whose url an earlier session wrote down — a pull request it opened —
   * starts as a fork of that session, so that the work behind the pull request is
   * known here without anybody repeating it. So does a review thread somebody cut
   * out of the pull request it is on, which arrives already knowing which thread
   * it splits and needs no url looked up.
   *
   * Forked rather than resumed, because both threads go on living: two of them
   * writing into one session would each find the other's turns in their history.
   */
  function adoptFork(mention: Mention, own: Remembered | undefined): void {
    // A thread that threw its own history away is not given somebody else's: a
    // session with none is exactly the gap a fork fills, and filling it would
    // undo the clear at the next mention rather than at some later one.
    if (cleared) {
      log.info("not forking into a thread that has been cleared", { url: mention.url });
      return;
    }
    if (splitFrom !== undefined) {
      carryOver(splitFrom.request, splitFrom.point, own, true);
      return;
    }
    if (mention.url === "") return;
    const request = forks.parentOf(mention.url);
    if (request === undefined) return;

    // Read through the session store, so a fork is subject to everything a resume
    // is: the parent's newest session, and only when it ran in this directory.
    const parent = store.get(request.from);
    if (parent?.sessionId === undefined) {
      log.info("this thread was recorded as another one's work, but that thread has no session here", {
        from: request.from,
        url: request.url,
      });
      return;
    }

    carryOver(request, { sessionId: parent.sessionId, settings: parent.settings ?? {} }, own, false);
  }

  /**
   * Settles which session this thread is on, from what it was left with last time
   * and from whatever it came out of. Read before anything is decided about a
   * mention, and again when another thread asks where this one has got to.
   */
  function pickUp(mention: Mention): void {
    conversationKey ??= mention.conversationKey;
    const remembered = store.get(ownKey() ?? mention.conversationKey);
    if (sessionId === undefined && remembered !== undefined) {
      sessionId = remembered.sessionId;
      cleared ||= remembered.cleared === true;
      settings = { ...remembered.settings, ...settings };
      current = applyThreadSettings(options, settings);
      log.info("picking a thread back up", { sessionId, settings });
    }
    if (sessionId === undefined) adoptFork(mention, remembered);
  }

  async function start(mention: Mention): Promise<void> {
    conversationKey ??= mention.conversationKey;

    const { directive, rest, problem } = parseDirective(
      say.spokenText(mention),
    );
    if (problem !== undefined) {
      reportTo(mention, problem);
      drain();
      return;
    }

    // Both of these do their work here rather than by running a turn, and both
    // still answer the thread, so a group carrying one is never the silent kind.
    const actsOnTheHistory =
      directive.clear === true || directive.compact === true;

    if (takeOn(directive.settings)) {
      // Most settings are start-up flags, so the change lands on a restart. The
      // session id is kept, so the thread keeps its history.
      if (restartsClaude(directive.settings)) await restart();

      if (rest === "" || actsOnTheHistory) {
        reportTo(mention, say.directiveNotice(directive.settings));
        if (!actsOnTheHistory) {
          drain();
          return;
        }
      }
    }

    if (actsOnTheHistory) {
      if (directive.clear === true) {
        const hadHistory = sessionId !== undefined || claude !== undefined;
        await forgetHistory();
        log.info("cleared the thread's history", { id: mention.id, hadHistory });
        reportTo(mention, say.clearedNotice(hadHistory));
      } else {
        await compactHistory(mention);
      }
      // Whatever followed the group runs as a turn of its own, once the history
      // it is to run on has settled: a compaction is still holding the turn.
      const next = rest === "" ? undefined : { ...mention, text: rest, prompt: rest };
      if (next !== undefined) waiting.push(next);
      drain();
      return;
    }

    await run(mention, rest);
  }

  return {
    forkPoint(mention) {
      pickUp(mention);
      return { sessionId, settings };
    },

    snapshot() {
      return {
        conversationKey: ownKey(),
        cwd: current.cwd,
        sessionId,
        model: current.model,
        effort: current.effort,
        state: parked !== undefined ? "waiting" : turn !== undefined ? "running" : "idle",
        thread,
        turn:
          turn === undefined
            ? undefined
            : {
                startedAt: turn.startedAt,
                url: turn.mention.url,
                author: turn.mention.author,
                steers: turn.steers,
              },
        parked:
          parked === undefined
            ? undefined
            : { tool: parked.ask.tool.name, isQuestion: parked.ask.isQuestion, since: parked.since },
        queued: waiting.length,
        mentions,
        turns,
      };
    },

    async handle(mention) {
      mentions += 1;
      thread = {
        platform: mention.platform,
        title: mention.title,
        url: mention.url,
        author: mention.author,
        receivedAt: mention.receivedAt,
      };
      conversationKey ??= mention.conversationKey;
      if (conversationKey !== mention.conversationKey) {
        // per-conversation gives one process per thread; anything else is a misconfiguration.
        log.warn("a mention from another conversation arrived", {
          expected: conversationKey,
          got: mention.conversationKey,
        });
      }

      pickUp(mention);

      // Read before the two branches below, because calling the agent off is the
      // one thing a person needs to be able to say while it is running or waiting.
      const parsed = parseDirective(say.spokenText(mention));
      // Ending the process subsumes stopping the turn, so it is read first.
      if (parsed.directive.exit === true) {
        await endProcess(mention);
        const next = afterDirective(mention, parsed);
        if (next !== undefined) waiting.push(next);
        drain();
        return;
      }
      if (parsed.directive.interrupt === true) {
        await interruptTurn(mention);
        const next = afterDirective(mention, parsed);
        if (next !== undefined) waiting.push(next);
        drain();
        return;
      }

      if (parked !== undefined) {
        log.info("this mention answers what the agent was waiting on", {
          id: mention.id,
        });
        answerWith(mention, say.spokenText(mention));
        return;
      }

      if (turn !== undefined) {
        // A setting that is a start-up flag cannot be folded into a turn already
        // under way; neither can a clear or a compact, which are about a history
        // this turn is still writing; neither can a group this program could not
        // read, because `start` reports the problem.
        const needsATurnOfItsOwn =
          parsed.problem !== undefined ||
          restartsClaude(parsed.directive.settings) ||
          parsed.directive.clear === true ||
          parsed.directive.compact === true;

        if (!needsATurnOfItsOwn && claude?.running === true) {
          // The rest go straight on, which is the point of writing one here:
          // `[progress=all]` is worth saying while a silent turn is still going.
          const changed = takeOn(parsed.directive.settings);
          if (changed) {
            reply.append(mention.replyFile, say.directiveNotice(parsed.directive.settings));
          }
          if (!changed || parsed.rest !== "") steer(mention, parsed.rest);
          return;
        }

        log.info("queued behind the running turn", {
          id: mention.id,
          waiting: waiting.length + 1,
        });
        waiting.push(mention);
        return;
      }

      await start(mention);
    },

    finish() {
      inputEnded = true;
      if (parked !== undefined) {
        log.warn(
          "nothing can answer the waiting request now that input has ended",
          { tool: parked.ask.tool.name },
        );
        settle(parked.ask, { behavior: "deny", message: say.noMoreAnswers() });
      }
      if (settled()) return Promise.resolve();
      return new Promise<void>((resolve) => settledWaiters.push(resolve));
    },

    async stop() {
      stopping = true;
      if (parked !== undefined) {
        settle(parked.ask, {
          behavior: "deny",
          message: "The bot is shutting down, so this was not approved.",
        });
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
