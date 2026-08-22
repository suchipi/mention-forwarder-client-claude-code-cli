#!/usr/bin/env node
import { parseArgs } from "node:util";
import { ConfigError, DEFAULT_CONFIG_FILE } from "./config-file.ts";
import { createConversation } from "./conversation.ts";
import { createLogger } from "./logger.ts";
import { readMentions } from "./mention.ts";
import { defaultStateFile, resolveOptions } from "./options.ts";
import { loadRules } from "./patterns.ts";
import { createReply } from "./reply.ts";
import { createSessionStore } from "./session-store.ts";

/** How long a stop signal waits for Claude Code to wind down before the process leaves anyway. */
const STOP_GRACE_MS = 10000;

const HELP = `mention-forwarder-claude-code - run forwarded @-mentions as turns in a Claude Code session

Usage: mention-forwarder-claude-code [options]

Reads mentions from mention-forwarder on stdin and runs each one as a turn in a
Claude Code session, keeping one session per conversation, so a thread and a
session share a memory. What the agent says is appended to the mention's reply
file, which mention-forwarder posts back where the mention came from.

Drives the "claude" binary over its stream-json protocol, so it runs on a Claude
subscription rather than on API billing.

Meant to be the "command" of a mention-forwarder configured with
"lifecycle": "per-conversation".

A mention may open with [model=..., effort=...] to set the model for its thread
from then on; what follows the group is passed to the agent as usual.

Options:
  -c, --config <path>       Settings file. Flags win over it. Default, when it
                            exists: ${DEFAULT_CONFIG_FILE}
  --binary <path>           The claude program to run (default "claude")
  --cwd <path>              Directory to run it in (default this process's own)
  --model <name>            Model new threads start on, e.g. opus, sonnet, haiku,
                            or a full name like claude-opus-5
  --effort <level>          Reasoning effort: low, medium, high, xhigh, or max
  --permission-mode <mode>  Passed to claude: default, acceptEdits, plan,
                            dontAsk, auto, or bypassPermissions
  --approval <mode>         What to do when the agent asks permission for a tool,
                            or asks a question:
                              ask    post it to the thread and wait (default)
                              allow  approve every gated tool, unattended
                              deny   refuse every gated tool, unattended
  --allowed-tools <list>    Passed to claude, e.g. "Read Grep Bash(git *)"
  --disallowed-tools <list> Passed to claude
  --add-dir <path>          Another directory the agent may touch (repeatable)
  --claude-arg <arg>        Passed to claude untouched (repeatable)
  --progress <mode>         all   post what the agent says as it says it (default)
                            final post only its answer, once the turn is done
  --ask-timeout <seconds>   Refuse a waiting request if nobody answers in this
                            long (default 0, which waits forever)
  --state-file <path>       Where conversation-to-session ids are remembered
                            (default ${defaultStateFile()})
  --no-state                Remember nothing, so every process starts a new session
  --patterns <path>         A module that patches how claude's output is read;
                            see "Pattern detection" in the README
  --record <path>           Append every raw event from claude here, for working
                            out why a pattern stopped matching
  --log-level <level>       debug, info (default), warn, or error
  -h, --help                Show this help
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: "string", short: "c" },
      binary: { type: "string" },
      cwd: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      "permission-mode": { type: "string" },
      approval: { type: "string" },
      "allowed-tools": { type: "string" },
      "disallowed-tools": { type: "string" },
      "add-dir": { type: "string", multiple: true },
      "claude-arg": { type: "string", multiple: true },
      progress: { type: "string" },
      "ask-timeout": { type: "string" },
      "state-file": { type: "string" },
      "no-state": { type: "boolean" },
      patterns: { type: "string" },
      record: { type: "string" },
      "log-level": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  const options = resolveOptions(values);
  const log = createLogger(options.logLevel);
  const rules = await loadRules(options.patternsFile, log);
  const store = createSessionStore(options.stateFile, options.cwd, log);
  const reply = createReply(log);
  const conversation = createConversation({ options, rules, store, reply, log });

  log.info("ready for mentions", {
    binary: options.binary,
    cwd: options.cwd,
    model: options.model ?? "the default",
    effort: options.effort ?? "the default",
    approval: options.approval,
    permissionMode: options.permissionMode ?? "the default",
    progress: options.progress,
    stateFile: options.stateFile ?? "off",
    patterns: options.patternsFile ?? "built in",
  });

  let stopping = false;
  const leave = () => {
    if (stopping) return;
    stopping = true;
    // mention-forwarder kills this process shortly after; leave either way.
    setTimeout(() => process.exit(0), STOP_GRACE_MS).unref();
    void conversation.stop().finally(() => process.exit(0));
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      log.info(`${signal} received, stopping`);
      leave();
    });
  }

  let queue = Promise.resolve();
  for await (const mention of readMentions(process.stdin, log)) {
    // Serialized so two mentions arriving together cannot both decide the
    // conversation is idle and start a turn each.
    queue = queue
      .then(() => conversation.handle(mention))
      .catch((error: unknown) => {
        log.error("could not handle a mention", {
          mention: mention.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  await queue;
  // stdin closing is how both lifecycles say "that was the last one", so the work
  // already in flight is finished before the process leaves.
  log.info("input closed, finishing what is running");
  await conversation.finish();
  await conversation.stop();
  log.info("session over");
}

try {
  await main();
} catch (error) {
  const isUsage = error instanceof ConfigError || (error as NodeJS.ErrnoException).code?.startsWith("ERR_PARSE_ARGS");
  if (!isUsage) throw error;
  process.stderr.write(`${(error as Error).message}\nRun with --help for the options.\n`);
  process.exit(1);
}
