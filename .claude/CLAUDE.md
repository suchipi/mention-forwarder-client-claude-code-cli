# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A [mention-forwarder](https://github.com/suchipi/mention-forwarder) client. It reads @-mentions (GitHub, Slack, Linear) off stdin, runs each as a turn in a Claude Code session by driving the `claude` binary over its stream-json protocol, and appends what the agent says to the mention's reply file, which mention-forwarder posts back to the thread.

[README.md](./README.md) is the user-facing manual and is thorough: options, the `[model=..., effort=...]` group, approvals, the wire protocol, troubleshooting. Read the relevant section there before changing behavior it documents; this file covers only what the README does not.

## Commands

| | |
| --- | --- |
| `npm test` | Unit tests plus `test/e2e.test.ts`, which runs the real CLI against `test/stub-claude.mjs`. |
| `node --test test/patterns.test.ts` | One test file. |
| `node --test --test-name-pattern "posts a question" test/e2e.test.ts` | One test. |
| `npm run typecheck` | `tsc --noEmit`. There is nothing else to build. |
| `./run.sh` (see README) | The whole loop locally: forwarder, simulator, this client, `claude`. |

## No build step

Node 22.18+ strips the types itself, so `src/cli.ts` is executed directly and `package.json`'s `bin` points at a `.ts` file. This constrains the source:

- Relative imports carry the `.ts` extension (`./patterns.ts`), never `.js` and never extensionless.
- `erasableSyntaxOnly` is on: no `enum`, no `namespace`, no constructor parameter properties. `verbatimModuleSyntax` is on, so type-only imports need `import type`.
- `strict` and `noUncheckedIndexedAccess` are on; indexing an array or record yields `T | undefined`.

## How one mention flows through

```
stdin ──▶ mention.ts ──▶ cli.ts (serialized queue) ──▶ conversation.ts ──▶ claude.ts ──▶ `claude` child
                                                              ▲                              │
                                    message.ts (prose)        └── signals ◀── patterns.ts ◀──┘
                                    reply.ts (reply file) ◀───┘
```

`conversation.ts` is the whole state machine and the only module that decides anything. It holds at most one running `turn`, at most one `parked` ask, and a `waiting` queue of mentions behind them. Each arriving mention takes exactly one of four paths, in this order: an interrupt group stops the running turn; otherwise a parked ask makes the mention that ask's answer; otherwise a running turn queues it; otherwise it starts a turn.

## Invariants

These are load-bearing across several files and are easy to break with a local-looking change.

**`patterns.ts` is the only module that reads a raw event shape.** Everything else works in the `Signal` union from `signals.ts`. A `claude` release that renames a field should be absorbable by editing `patterns.ts` alone, or by a user's `--patterns` file. Reach for the accessors in that file (`str`, `num`, `record`, `list`) rather than indexing an event directly, so a drifted shape degrades instead of throwing. An event no rule claims becomes `{kind: "unrecognized"}` and is logged loudly; rules are tried in order, so narrow shapes must stay ahead of the catch-alls at the end of `DEFAULT_RULES`.

**`message.ts` owns every word that reaches a thread.** `conversation.ts` imports it as `say` and posts nothing it composes itself. Anything a person will read in a GitHub or Slack comment belongs there, where it can be tested without a process.

**Model and effort are start-up flags for `claude`, so changing them restarts the child on the same session id.** That is why `restart()` exists and why `sessionId` is not cleared by it: the thread keeps its history. The session id and the thread's settings both live in `session-store.ts`.

**A remembered session is only reused for the same `cwd`.** Claude Code files sessions under the directory it ran in, so an entry recorded under another directory is ignored. A resume that fails is retried once without the id rather than failing the thread.

**Only one ask can be parked at a time**, because only the next comment can answer it, and answering moves the turn's output onto the answering mention's reply file.

## Changing things

**Adding an option** touches four places, and the tests will not catch a missed one: `cli.ts` (the `parseArgs` map and the `HELP` text), `options.ts` (`Flags`, `Options`, `resolveOptions`), `config-file.ts` (the `ConfigFile` type plus the `STRING_FIELDS` / `STRING_LIST_FIELDS` / `NUMBER_FIELDS` / `PATH_FIELDS` lists), and the two README tables under "Settings" and "Options". Unknown or wrongly typed config keys are refused at startup, so a field missing from those lists makes a valid config an error.

**The README is a test fixture.** `test/directive.test.ts` parses the word lists out of it and asserts they equal `INTERRUPT_WORDS` (`src/directive.ts`) and `APPROVALS` (`src/answer.ts`). Changing either set, or the README headings `## Stopping a turn` and `### How to answer`, or the fenced blocks under them, fails the test.

**`test/patterns.test.ts` holds real `claude` output**, copied from actual runs with long fields shortened. When a release changes a shape, add the new event there; that file is the record of what this program supports.

**`test/stub-claude.mjs` is not part of the program.** It speaks enough of the control protocol to script a run, chosen by `CLAUDE_STUB_SCENARIO`, so the whole pipeline is covered without a model or a network. New end-to-end behavior usually means a new scenario there.
