# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A [mention-forwarder](https://github.com/suchipi/mention-forwarder) client. It reads @-mentions (GitHub, Slack, Linear) off stdin, runs each as a turn in a Claude Code session by driving the `claude` binary over its stream-json protocol, and appends what the agent says to the mention's reply file, which mention-forwarder posts back to the thread.

[README.md](./README.md) is the user-facing manual and is thorough: options, the `[model=..., effort=...]` group, approvals, the wire protocol, troubleshooting. Read the relevant section there before changing behavior it documents; this file covers only what the README does not.

## Commands

|                                                                       |                                                                                             |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `npm test`                                                            | Unit tests plus `test/e2e.test.ts`, which runs the real CLI against `test/stub-claude.mjs`. |
| `node --test test/patterns.test.ts`                                   | One test file.                                                                              |
| `node --test --test-name-pattern "posts a question" test/e2e.test.ts` | One test.                                                                                   |
| `npm run typecheck`                                                   | `tsc --noEmit`. There is nothing else to build.                                             |
| `./run.sh` (see README)                                               | The whole loop locally: forwarder, simulator, this client, `claude`.                        |

## No build step

Node 22.18+ strips the types itself, so `src/cli.ts` is executed directly and `package.json`'s `bin` points at a `.ts` file. This constrains the source:

- Relative imports carry the `.ts` extension (`./patterns.ts`), never `.js` and never extensionless.
- `erasableSyntaxOnly` is on: no `enum`, no `namespace`, no constructor parameter properties. `verbatimModuleSyntax` is on, so type-only imports need `import type`.
- `strict` and `noUncheckedIndexedAccess` are on; indexing an array or record yields `T | undefined`.

## How one mention flows through

```
stdin ──▶ mention.ts ──▶ cli.ts (serialized queue) ──▶ threads.ts ──▶ conversation.ts ──▶ claude.ts ──▶ `claude` child
                                                                            ▲                            │
                                                  message.ts (prose)        └── signals ◀── patterns.ts ◀┘
                                                  reply.ts (reply file) ◀───┘
```

`threads.ts` decides only which conversation a mention belongs to, which is usually the one this process was started for. `conversation.ts` is the whole state machine and the only module that decides anything else. It holds at most one running `turn`, at most one `parked` ask, and a `waiting` queue of mentions behind them. Each arriving mention takes exactly one of five paths, in this order: an exit group ends the `claude` process, turn and all; otherwise an interrupt group stops the running turn; otherwise a parked ask makes the mention that ask's answer; otherwise a running turn takes it as a message part-way through itself, unless it carries a group that cannot join one, which queues it; otherwise it starts a turn — or, where the group was `[clear]` or `[compact]`, settles the thread's history first and leaves whatever followed the group to a turn of its own.

## Invariants

These are load-bearing across several files and are easy to break with a local-looking change.

**`patterns.ts` is the only module that reads a raw event shape.** Everything else works in the `Signal` union from `signals.ts`. A `claude` release that renames a field should be absorbable by editing `patterns.ts` alone, or by a user's `--patterns` file. Reach for the accessors in that file (`str`, `num`, `record`, `list`) rather than indexing an event directly, so a drifted shape degrades instead of throwing. An event no rule claims becomes `{kind: "unrecognized"}` and is logged loudly; rules are tried in order, so narrow shapes must stay ahead of the catch-alls at the end of `DEFAULT_RULES`.

**`message.ts` owns every word that reaches a thread.** `conversation.ts` imports it as `say` and posts nothing it composes itself. Anything a person will read in a GitHub or Slack comment belongs there, where it can be tested without a process. Whether there is anything worth saying at all belongs there too: a function may return `undefined`, and its caller appends only what it gets back, so that judgement sits next to the words it is about.

**A thread whose session opened as a copy of another one's is told so on every run, not only the one that copied it.** `forkParent` is the run that copies; `forked` is what that run left behind, and it is what puts the line about a shared working directory in the system prompt. The two are separate because the sharing outlives the copying: the thread it was forked from goes on living in the same `cwd`, and nothing here keeps the two apart, so `forked` is written to the session store and read back by the next process rather than starting quiet. The line names the worktree in the copied history as the other thread's, because that history is one in which the agent made a worktree and worked in it — told only to work in a worktree of its own, a forked session reads that as already done and carries on in the one it inherited.

**Model and effort are start-up flags for `claude`, so changing them restarts the child on the same session id.** That is why `restart()` exists and why `sessionId` is not cleared by it: the thread keeps its history. The session id and the thread's settings both live in `session-store.ts`.

**A compaction holds the turn slot, and works out for itself which end is its own.** `[compact]` is `claude`'s `/compact`, sent as a user message because a message that is nothing but a slash command is the only way the CLI takes one; there is no control request for it. No model turn runs, so the turn opened for it exists to hold the thread's place, to give `compactedNotice` somewhere to post, and to keep what followed the group from running until the history it is to run on has settled. What makes the end hard to place is that a compaction finishes in exactly the shape `endedAPromptOfItsOwn` was written to ignore, while a message that reached the turn before it leaves the CLI a prompt of its own that it answers first, with model work in it and an answer the thread should have. So a compacting turn closes on an end with no model work in it, or on any end once a `compacted` signal has arrived, and anything before that is the queued prompt.

**A thread that cleared its history is never forked into.** `[clear]` ends the process and drops the session id, and having no session is exactly the gap `adoptFork` fills, so without this the very next mention would hand back the history the thread had just asked to be rid of. The clear is recorded in `session-store.ts` as well as held in memory, because the fork would otherwise come back in the next process. Nothing else clears that flag: a thread that has had its own history and dropped it does not want anybody else's.

**A remembered session is only reused for the same `cwd`.** Claude Code files sessions under the directory it ran in, so an entry recorded under another directory is ignored. A resume that fails is retried once without the id rather than failing the thread.

**A thread that another thread's session claimed is forked into, never resumed into.** `fork-store.ts` reads lines an agent wrote itself — a url it opened, and the conversation it wrote from — and a mention arriving at or under one of those urls starts on `--resume=<that conversation's session> --fork-session`. Both threads go on living, which is what rules out a plain resume: they would each find the other's turns in their history. The flag is spent as soon as the CLI comes back with a session id, or a later restart would fork the fork, and the message opening a forked session says which thread it is now in, because everything above it was said to people who cannot see this one. The parent's model and effort come across with its history, under everything the new thread had already settled for itself. While the id held is still the parent's, `remember()` writes the entry without it: kept, the next process would read it back and resume it rather than fork it, and both threads would be writing their turns into one history. Nothing here writes that file. The agent does, because it is the only thing that knows a pull request was opened at all, and `message.ts` is where it is asked to.

**A review thread becomes a conversation of its own only by asking, and only where it can be recognized again.** A pull request is one conversation however many review threads are open on it: every review comment arrives under its `conversationKey`, so `[fork]` in one of them is what splits it out, into a `Conversation` of its own with its own key, its own `claude` and its own session forked off the pull request's. Which thread a comment is in is the one thing a mention does not say — a reply's permalink names the reply, and only `in_reply_to_id` in the webhook payload ties it to the thread — so `review-thread.ts` reads `mention.raw`, which is there only when mention-forwarder's `includeRawPayload` is on, and says nothing rather than guessing: a thread whose later comments could not be recognized would be given a session that answered once and was never reached again. The session store is what makes a fork outlive the process: the entry is written the moment the fork is asked for, before anything has run in it, because it is both what a second `[fork]` finds and what tells the next process to send that thread's mentions to a conversation of its own. An entry with no session id in it is a fork that never got to run, and is split off its parent again rather than started blank. A fork that worked says nothing in the thread — whatever followed the group is answered under the same comment, so a line saying it happened only ever lands on top of that answer. What is spoken is what left the thread with something other than what it asked for: a fork refused, and a fork that found no session to copy and so starts blank.

**Only one ask can be parked at a time**, because only the next comment can answer it, and answering moves the turn's output onto the answering mention's reply file.

**A mention that reaches a running turn is written straight into it, and nothing acknowledges that.** Claude Code takes a user message written part-way through a turn and folds it in at its next step, which is the whole mechanism: `steer()` is one `claude.send()`. No event comes back to say it landed, which is why the notice to the thread is posted on the way out rather than when the agent acts on it, and why `interrupt()`'s `cancel_queued: true` can discard one that had not landed yet — stopping promptly is the deliberate trade. A steer does not move the turn's output: the turn goes on answering under the mention that started it, and only an acknowledgement is written to the steering mention's reply file, naming the url that answer will appear under. Nothing is written when that url is in the thread the steer was written in, and a reply file left empty is posted as no comment at all, so the thread hears nothing until the answer itself arrives. Which threads those are is `answeredTogether` in `message.ts`, and it is knowledge of mention-forwarder rather than of this program: every Slack mention, and a GitHub issue comment, review summary or commit comment, are answered on the conversation as a whole, where a GitHub review comment, a GitHub discussion comment and a Linear comment are each answered under the comment they hang off. Two GitHub review comments in one review thread are the exception to that exception, forked or not: a reply to a review comment lands in that comment's own thread, so both are answered where both are being read, and `review-thread.ts` is what can tell. A kind it does not name keeps the notice, because a pointer nobody needed costs less than an answer nobody can find. So one turn can still answer several mentions with a single reply, but that reply lands where the turn began rather than under whichever comment interrupted it last. This is the one place a steer differs from answering a parked ask, which does move the output, because there the agent is waiting on that particular reply.

## Changing things

**Adding an option** touches five places, and only the last of them is checked by a test: `cli.ts` (the `parseArgs` map and the `HELP` text), `options.ts` (`Flags`, `Options`, `resolveOptions`), `config-file.ts` (the `ConfigFile` type plus the `STRING_FIELDS` / `STRING_LIST_FIELDS` / `NUMBER_FIELDS` / `PATH_FIELDS` lists), the two README tables under "Settings" and "Options", and `mention-forwarder-claude-code.config.schema.json`. Unknown or wrongly typed config keys are refused at startup, so a field missing from those lists makes a valid config an error.

**The README is a test fixture.** `test/directive.test.ts` parses the word lists out of it and asserts they equal `INTERRUPT_WORDS`, `EXIT_WORDS`, `CLEAR_WORDS`, `COMPACT_WORDS` and `FORK_WORDS` (`src/directive.ts`) and `APPROVALS` (`src/answer.ts`). Changing any of those sets, or the README headings `## Stopping a turn`, `## Ending the process`, `## Clearing the context`, `## Compacting the context`, `## Forking a review thread`, and `### How to answer`, or the first fenced block under each, fails the test.

**The settings schema is a test fixture too.** `test/config-schema.test.ts` asserts that `mention-forwarder-claude-code.config.schema.json` describes exactly `KNOWN_FIELDS` (`src/config-file.ts`) and that its `enum` lists equal `EFFORT_LEVELS`, `PERMISSION_MODES`, `APPROVAL_MODES`, `PROGRESS_MODES`, and `LEVELS`. What no test can check is whether the prose is still true, and that prose is what somebody hovers in their editor: a setting whose behavior changes needs its `description`, `markdownDescription`, and `enumDescriptions` changed with it. A config file may carry `$schema` itself, which `config-file.ts` accepts and ignores.

**`test/patterns.test.ts` holds real `claude` output**, copied from actual runs with long fields shortened. When a release changes a shape, add the new event there; that file is the record of what this program supports.

**`test/stub-claude.mjs` is not part of the program.** It speaks enough of the control protocol to script a run, chosen by `CLAUDE_STUB_SCENARIO`, so the whole pipeline is covered without a model or a network. New end-to-end behavior usually means a new scenario there.
