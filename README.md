# mention-forwarder-client-claude-code-cli

Runs the @-mentions that [mention-forwarder](https://github.com/suchipi/mention-forwarder) picks up from GitHub, Slack, and Linear as turns in a [Claude Code](https://claude.com/claude-code) session, and posts what the agent says back to the thread the mention came from.

It drives the `claude` binary itself, over the stream-json protocol that binary already speaks, so it runs on whatever `claude` is logged in as. On a Claude Pro or Max subscription that means the flat fee, not API billing.

```
GitHub  ──┐                       mentions on stdin                  a turn each
Slack   ──┤──▶ mention-forwarder ──────────────────────▶ this ──────────────────▶ claude
Linear  ──┘           ▲                                      ◀──── what the agent said
                      └─────────────── reply file ───────────┘
```

One conversation is one session. Every mention on the same GitHub issue, Slack thread, or Linear issue continues the same Claude Code session, so the agent still knows what it was doing there; mentions in different places never share context. Each thread can also be put on its own model, reasoning effort, or any other setting the config file takes, by opening a mention with a group like `[model=opus, effort=max]`, a comment written while the agent is working reaches the turn it is working on, a turn already running can be called off with `[stop]`, and a thread's history can be thrown away with `[clear]` or summarized in place with `[compact]`.

| mention-forwarder                  | this program                                | Claude Code                            |
| ---------------------------------- | ------------------------------------------- | -------------------------------------- |
| A conversation (`conversationKey`) | one process, one remembered session id      | a session, resumable by id             |
| A mention                          | one message                                 | a turn                                 |
| The reply file                     | what the agent said, appended as it arrives | `text` blocks from the main agent      |
| A comment answering the bot        | an answer to what it was waiting on         | a `can_use_tool` decision              |
| A comment while it is working      | a message into the turn already running     | a user message part-way through a turn |

## Requirements

- **Node.js 22.18 or newer**, the same as mention-forwarder. The source is TypeScript and runs as it is, because Node strips the types itself, so there is no build step.
- **The `claude` CLI**, logged in. Check with `claude --version` and `claude auth`. Anything `claude` can do in that directory, the bot can do, so point it at a checkout you are happy for it to work in.

Built and tested against Claude Code 2.1.239. If a later release changes the shape of what it prints, see [Pattern detection](#pattern-detection).

## Quick start

```sh
git clone <this repo> && cd mention-forwarder-client-claude-code-cli
npm install
```

Feed it one mention by hand to check it can drive `claude`:

```sh
echo '{"id":"1","conversationKey":"test","replyFile":"/tmp/reply.md","platform":"terminal","author":"you","prompt":"say hello"}' \
  | node src/cli.ts --no-state
cat /tmp/reply.md
```

Then point mention-forwarder at it, in its `mention-forwarder.config.json`:

```json
{
  "command": [
    "node",
    "/absolute/path/to/mention-forwarder-client-claude-code-cli/src/cli.ts"
  ],
  "cwd": "/absolute/path/to/the/checkout/the/agent/should/work/in",
  "lifecycle": "per-conversation",
  "timeoutMs": 0,
  "sessionIdleMs": 900000,
  "ignoreBots": true,
  "github": { "triggerPhrases": ["@my-bot"] },
  "linear": { "triggerPhrases": ["@my-bot"] }
}
```

The five settings that matter, and why:

| Setting                           | Why                                                                                                                                                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"lifecycle": "per-conversation"` | What this is built for. `per-mention` works too, because the remembered session ids still point every mention at the same session, but a thread cannot answer anything there: what the agent is waiting for is only known while the process lives. |
| `"cwd"`                           | Claude Code works in the directory it is started in, and files its session under that directory. This is the checkout the agent reads and edits.                                                                                                   |
| `"timeoutMs": 0`                  | A turn can take many minutes, and this is a cap on the whole process, not on one mention.                                                                                                                                                          |
| `"sessionIdleMs"`                 | How long a quiet thread keeps a process alive. Closing one costs nothing: the session id is remembered, so the next mention resumes the same session.                                                                                              |
| `"ignoreBots": true`              | Keeps the agent from answering its own replies forever.                                                                                                                                                                                            |

A copy of that config is in [mention-forwarder.config.example.json](./mention-forwarder.config.example.json). Settings for this program itself go in a file of its own, [described below](#settings).

### Or run the whole thing with one script

[`run.sh`](./run.sh) starts mention-forwarder with this client already wired in as its command. It expects mention-forwarder checked out beside this repo, writes the config files into `.run/` the first time, and leaves them alone after that so your edits survive.

```sh
SIM_PLATFORM=github ./run.sh
```

That also brings up [mention-forwarder's simulator](https://github.com/suchipi/mention-forwarder/blob/main/simulator/README.md), which stands in for GitHub, Slack, or Linear at <http://127.0.0.1:4000>. Post `@my-bot have a look` in one of its threads and the whole round trip happens on your machine: a signed webhook, the forwarder, this client, `claude`, and the reply landing back in the thread. No account, no tunnel, nothing to register. The secrets are fake on purpose, and only the platform being simulated is switched on.

Leave `SIM_PLATFORM` out to run against the real thing, which needs a webhook secret in `.run/mention-forwarder.env` and a tunnel to your machine.

Anything on `run.sh`'s own command line is passed to this client, which is how you reach a flag while testing without editing the config it wrote:

```sh
./run.sh --no-state --log-level debug
```

| Environment             |                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MENTION_FORWARDER_DIR` | Where mention-forwarder is checked out. Default `../mention-forwarder`.                                                                          |
| `CONFIG_DIR`            | Where the generated config lives. Default `./.run`.                                                                                              |
| `AGENT_CWD`             | The checkout the agent works in. Default `$CONFIG_DIR/workspace`, which starts empty; point it at something real once you trust the bot with it. |
| `TRIGGER`               | The phrase that counts as a mention. Default `@my-bot`. Read when the config is first written.                                                   |
| `SIM_PLATFORM`          | `github`, `slack`, or `linear`. One simulator imitates one platform.                                                                             |
| `SIM_PORT`              | The simulator's port. Default `4000`.                                                                                                            |
| `WEB_PORT`              | The [web view](#seeing-what-is-running)'s port. Default `4100`; `0` for none. Read when the config is first written.                              |

## What the agent is told

The first mention of a conversation opens the session with the whole context:

```
[github:acme/widgets#7] Flaky test in CI

You are answering an @-mention that mention-forwarder picked up. Whatever you say in reply is posted back to that thread as a comment, so write for the people reading it there. Later mentions in the same thread arrive as further turns in this session.

@suchipi said, via github issue_comment (https://github.com/acme/widgets/issues/7#issuecomment-100):
please fix the flaky test
```

Every later mention in that conversation is shorter, because the session already holds everything above:

```
@suchipi said, via github issue_comment (https://github.com/acme/widgets/issues/7#issuecomment-101):
also update the changelog
```

That label is the only place a message names anybody, and it is the last thing before the words it belongs to. A thread has more than one person in it, and the agent is asked to read the label before it attributes anything or quotes anybody, so nothing is allowed between the two. The permalink is parenthetical so that the colon ends the line and everything after it is what was actually said. A mention that carried no platform or no permalink leaves those parts out; one whose author is unknown says `someone`.

The label goes on what is left of a mention once a `[...]` group has been taken off the front, so `[stop] do this instead` still stops the turn and then runs as its own. Were it the other way round the group would no longer be at the start, nothing would match it, and the turn it was meant to call off would keep going. An answer to a permission request or a question is named the same way when it reaches the agent.

A few lines are also appended to the session's system prompt, because Claude Code otherwise has every reason to believe it is talking to somebody at a terminal: that its replies are posted as comments, that nobody is at a keyboard, where the thread is, and how long an answer takes to come back. What it says depends on `--approval`.

The thread's link is the mention's own permalink, from whichever mention started the process, and it comes with a note that only the mentions themselves reach the agent, so the rest of the thread is worth reading. A mention that arrives without a permalink leaves the line out.

A thread whose session opened as a copy of another one's — [a pull request's](#threads-that-come-out-of-other-threads), or [a review thread's](#forking-a-review-thread) — is told one thing more, on every run and not only the one that copied it, because the thread it was copied from is still live and has an agent of its own in this same working directory:

> This thread's session was forked from another thread's, which is still live and has an agent of its own working in the same directory. Any worktree or branch named above belongs to that thread rather than to you, however much of the history above reads as your own doing, and its files can change under you between one step and the next. Before you change anything, make a git worktree of your own and work only in it; git will not check out a branch that is checked out elsewhere, so where your work belongs on that branch, take a detached worktree at its head and push from there.

It names the worktree rather than only asking for one, because the history it copied is a history in which the agent already made a worktree and worked in it. Told only to work in a worktree of its own, a forked session reads that as done and carries on in the one it inherited — which is the thread it was forked from, still working there.

The system prompt also asks the agent for one thing back: when it opens a pull request, it writes a line naming that pull request into a file this program reads on the way up. That is what lets the thread the pull request becomes carry on from the session that opened it, and [Threads that come out of other threads](#threads-that-come-out-of-other-threads) is the whole of how. Under `--no-state` there is nowhere to write it, so the request is left out.

### Telling it something of your own

`appendSystemPrompt` goes after those lines, at the end of the system prompt, so it is where standing instructions belong: where to do the work, a house style for replies, anything every thread should be told.

```json
{
  "appendSystemPrompt": "Before you change anything, make a git worktree and a branch, and do the work there. Name the branch after the work in kebab-case, prefixed with the ticket id when the thread names one, and rename it before opening a pull request if the id only turns up later."
}
```

It applies to every thread this process handles, and unlike the model, a thread cannot change it mid-conversation. `--append-system-prompt` is the same thing as a flag.

## What gets posted back

Each finished block of prose from the **main agent** is appended to the mention's reply file, so a long run reports as it goes rather than staying silent. mention-forwarder posts each settled batch, so several blocks close together arrive as one comment and blocks further apart arrive as separate ones. Pass `--progress final` to post only the answer, once the turn is done; [the web view](#everything-a-session-has-done) is where the work in between stays legible, and `[progress=all]` written in the thread — even into a turn already running — brings it back there. A turn that stops for a person is the exception: what it is waiting on goes up the moment it asks, along with whatever the agent said on its way there, because nobody can answer a request they were never shown.

Also posted: anything the turn is waiting on a person for (below), and a line when a turn fails. Nothing else. Thinking, tool calls, tool results, and subagent chatter go to the log, which mention-forwarder prefixes and prints, and never to the thread.

A turn that says nothing posts nothing, which a tool-only turn can do. Run with `--log-level debug` to see what it did instead.

## Approvals and questions

Permission prompts are routed to this program rather than refused by the CLI, which is what `--permission-prompt-tool stdio` does. What happens next is `--approval`:

| Mode            | A tool that needs permission                                                           | A question the agent asks with `AskUserQuestion`                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ask` (default) | Posted to the thread; the turn waits for somebody to answer.                           | Posted to the thread with its options; the turn waits.                                                                                                       |
| `allow`         | Approved, unattended.                                                                  | Posted to the thread with its options; the turn waits. A question is the one thing `allow` does not approve, since approving it would not produce an answer. |
| `deny`          | Refused, unattended. What it wanted to run is listed in the thread when the turn ends. | Refused, with a note telling the agent to put the question in its reply instead.                                                                             |

### What lands in the thread

A tool that needs permission:

> The agent needs permission before it can carry on. It wants to run `Write` on banana.txt.
>
> `{"file_path":"/repo/banana.txt","content":"banana"}`
>
> Reply with any of these, and nothing else, to allow it: `approve`, `approved`, `allow`, `allowed`, `yes`, `y`, `ok`, `okay`, `lgtm`, `sure`, `go ahead`, `do it`, `proceed`, `yep`, `yeah`, 👍. Any other reply refuses it, and what you write is given to the agent as the reason.

A shell command, whose summary of what it does goes in the sentence rather than being named as the thing it acts on:

> The agent needs permission before it can carry on. It wants to run the shell command `git push origin main` (Push the branch).
>
> Reply with any of these, and nothing else, to allow it: `approve`, `approved`, `allow`, `allowed`, `yes`, `y`, `ok`, `okay`, `lgtm`, `sure`, `go ahead`, `do it`, `proceed`, `yep`, `yeah`, 👍. Any other reply refuses it, and what you write is given to the agent as the reason.

A question:

> The agent has a question:
>
> Do you prefer tabs or spaces for indentation?
>
> - `Tabs`: Use tab characters for indentation
> - `Spaces`: Use space characters for indentation
>
> Reply here with your answer — one of the labels above, or your own words — and it will carry on.

**A tool that wants a card of its own is still a permission request.** Some tools set `requires_user_interaction` because the CLI would normally draw them their own dialog, but they still run something once somebody says yes, so the thread gets a request it can approve:

> The agent needs permission before it can carry on. It wants to run `EnterWorktree` on a worktree for ENG-1234.
>
> `{"branch":"lily/eng-1234-thing"}`
>
> Reply with any of these, and nothing else, to allow it: `approve`, `approved`, `allow`, `allowed`, `yes`, `y`, `ok`, `okay`, `lgtm`, `sure`, `go ahead`, `do it`, `proceed`, `yep`, `yeah`, 👍. Any other reply refuses it, and what you write is given to the agent as the reason.

Only the tool whose card *is* the question — `AskUserQuestion`, which carries the questions in its own input — has nothing to approve, and only that one takes an answer in words.

### How to answer

**The reply has to be a mention like any other.** mention-forwarder only forwards a comment that triggers it, so an answer that does not is never delivered and the turn goes on waiting:

| Where                     | Write                                                    |
| ------------------------- | -------------------------------------------------------- |
| GitHub, Linear            | `@my-bot approve` (whatever you set as a trigger phrase) |
| A Slack channel or thread | `@my-bot approve`                                        |
| A Slack DM                | `approve`, since a DM needs no mention                   |

**The next mention in that conversation is the answer.** It is not run as a new turn, and whatever the agent goes on to say is posted under that comment rather than under the one that started the turn.

**A question takes an answer in your own words.** Anything you write is handed to the agent, which carries on with it. There is nothing to match and no wrong reply.

**A permission request takes a yes or anything else.** The request itself lists them, so there is nothing to look up here, but the whole of what you wrote, with the trigger phrase removed, has to be one of these to count as yes:

```
approve   approved   allow   allowed   yes   y   ok   okay
lgtm      sure       go ahead          do it       proceed
yep       yeah       👍
```

Case does not matter and a trailing `.`, `!`, `,`, `;`, or `:` is ignored, so `Approve.` and `LGTM` both count. **It is the entire message that is matched, not a phrase inside it**, which is what stops a refusal from being read as approval. So these are all refusals, and each one is handed to the agent as the reason it may not run the tool:

| Reply                                    | Read as                                  |
| ---------------------------------------- | ---------------------------------------- |
| `@my-bot approve`                        | yes                                      |
| `@my-bot no, that file is generated`     | no, and the agent is told why            |
| `@my-bot please do it after the release` | no, even though it contains "do it"      |
| `@my-bot approve the other one`          | no, even though it starts with "approve" |

If you meant yes, say only yes. Anything you want the agent to know goes in the mention after it has carried on.

### Waiting

Under `ask`, a turn can wait indefinitely, which is usually what you want for a thread somebody will get back to tomorrow. `--ask-timeout <seconds>` puts a limit on it, after which the request is refused and the agent is told why. Claude Code's own five minute deadline for a parked prompt is pushed out of the way (`CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS`), so it is this program that decides.

A request only lives as long as the process holding it. If mention-forwarder closes the session first (`sessionIdleMs`), the request is gone, and a reply that would have answered it is run as an ordinary new turn instead. Set `sessionIdleMs` comfortably longer than you expect anyone to take.

`--permission-mode` is separate and passed straight to `claude`: it decides which tools ask at all. `acceptEdits` is a good pairing with `--approval ask`, since it stops every file edit from needing a comment.

## Settings a thread can change

Whoever writes the mention picks what the thread runs on, with a bracketed group at the very start of what they wrote:

```
@my-bot [model=opus, effort=max] work out why the deploy hangs
```

The group is read, applied to the thread, and removed; the agent is given only what follows it. Nothing has to be configured for this to work, and it needs no access to the machine the bot runs on.

Every setting is written under the name [the config file](#settings) gives it. These are the ones a thread may take on:

| Setting                             | Takes                                                                                                                   | When it lands |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `model`                             | Anything `claude --model` takes: an alias like `opus`, `sonnet`, `haiku` or `fable`, or a full name like `claude-opus-5`. | On a restart  |
| `effort`                            | `low`, `medium`, `high`, `xhigh`, or `max`.                                                                              | On a restart  |
| `binary`                            | The program to run in place of `claude`.                                                                                 | On a restart  |
| `permissionMode`                    | `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`, or `auto`, spelled as written.                          | On a restart  |
| `approval`                          | `ask`, `allow`, or `deny`.                                                                                               | On a restart  |
| `appendSystemPrompt`                | Anything, added to the end of the system prompt the next session starts with.                                            | On a restart  |
| `allowedTools`, `disallowedTools`   | A tool list, as one string, e.g. `Read Grep Bash(git *)`.                                                                | On a restart  |
| `addDirs`, `claudeArgs`             | One value each time the name is written.                                                                                 | On a restart  |
| `progress`                          | `all` or `final`.                                                                                                        | At once       |
| `askTimeoutSeconds`                 | Zero, or a positive number of seconds.                                                                                   | At once       |

The rest of the file belongs to the whole process, which is running every conversation active on this machine at once: `cwd`, `stateFile`, `patternsFile`, `recordFile`, `webPort` and `logLevel`. A group naming one of those is answered with why it cannot be moved rather than quietly ignored; change it in the config file, or with its flag, and start the program again.

|                   |                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Where it goes     | First thing after the trigger phrase, and nothing before it. `look at this [model=opus]` is ordinary text.                                                                                                                                |
| Shape             | Comma-separated `name=value` pairs, any of them alone, in any order. Setting names are not case sensitive; whether a value is depends on the setting. A value cannot hold a comma, since that is what separates one pair from the next.    |
| Lists             | `addDirs` and `claudeArgs` hold more than one, so write the name again for each: `[addDirs=../shared, addDirs=/srv/other]`.                                                                                                               |
| How long it lasts | Every later mention in that thread runs on it too, until another group changes it. It is remembered alongside the session id, so it survives the process going away.                                                                      |

Some examples:

| Written in the thread                                       | What happens                                                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@my-bot [model=sonnet] have a look`                        | The thread moves to Sonnet and the agent is asked to have a look.                                                                                                      |
| `@my-bot [effort=max]`                                      | Nothing but the group, so this is an instruction to the bot alone: the thread moves to maximum effort and it answers with a line saying so, without running the agent.  |
| `@my-bot [progress=all]` while the agent is working         | The thread starts seeing the work at once, and whatever `final` was holding back is posted. The turn carries on where it was; nothing is restarted.                     |
| `@my-bot [addDirs=../shared, addDirs=/srv/other] go`        | The thread runs with both directories, in place of whatever the process was started with.                                                                              |
| `@my-bot [EFFORT=High, Model=opus] go`                      | The same as `[effort=high, model=opus] go`.                                                                                                                            |
| `@my-bot [WIP] have a look`                                 | Ordinary text. `WIP` is not `name=value`, so the whole group is left alone and reaches the agent as written.                                                            |
| `@my-bot [fixes=#12] go`                                    | Ordinary text too: `fixes` is not a setting, so those brackets are somebody else's.                                                                                    |
| `@my-bot [effort=turbo] go`                                 | `turbo` is not an effort level, so the bot says so in the thread and does not run the mention.                                                                          |
| `@my-bot [logLevel=debug] go`                               | `logLevel` belongs to the process, so the bot says which one it is and why, and does not run the mention.                                                              |
| `@my-bot [model=nonesuch] go`                               | Passed to `claude`, which cannot use it. What `claude` says about it is posted to the thread.                                                                          |

Most of these are start-up flags, so changing one restarts the `claude` process on the same session id. The thread keeps its history. It is also why a group carrying one cannot join a turn already running: a mention that changes the model waits for a turn of its own, where a mention without a group would have been [steered into the running turn](#steering-a-running-turn) instead.

`progress` and `askTimeoutSeconds` are this program's own doing rather than the CLI's, so nothing has to be restarted for them. A group carrying only those is folded into the turn already running and takes hold there, which is what makes `[progress=all]` worth writing into a turn that has gone quiet: what it has said so far is posted the moment it is read, and the rest as it arrives.

One case where a group is not read: while the agent is waiting on a permission request or a question, the next mention is that answer, so it is handed over as written rather than scanned for settings. Change a setting in a mention that starts a turn. The exceptions are [`[stop]`](#stopping-a-turn), [`[exit]`](#ending-the-process) and [`[fork]`](#forking-a-review-thread), which are read wherever they appear.

## Steering a running turn

A comment written while the agent is working does not wait for it to finish. It goes to the turn already running, which takes it at its next step — after the tool call or the reply it was part-way through — and answers it as part of that same turn. This is what Claude Code does with a message typed at its prompt mid-turn, and it is what happens here by default. Nothing has to be configured and there is nothing to write:

```
@my-bot actually, check the release branch too
```

The turn goes on answering under the comment that started it, so a mention steered in from somewhere else does not drag the answer out of the thread that asked for it — which on GitHub would be a different review thread. Answering [a question the agent asked](#how-to-answer) is the one thing that does move a turn's output, because there the agent is waiting on that reply.

Where that leaves the steering comment out of sight of the answer — another GitHub review thread, another discussion comment, another Linear comment — it gets a line back pointing at where the answer will appear, because nothing else would show that it landed:

> The agent is already working here, so this went to the turn already running. That turn answers under the comment that started it: https://github.com/acme/widgets/pull/7#discussion_r100
>
> Open a comment here with `[fork]` to give this review thread a session of its own, running beside the pull request rather than behind it.

The second half is offered to a GitHub review thread and nowhere else, since [forking](#forking-a-review-thread) is a thing only a review thread can ask for — and waiting on a turn that started somewhere else is what it is for, which is worth saying where somebody is watching it happen.

That notice is all the steering comment gets, and it is posted only when there is somewhere else to point at. A Slack thread, a GitHub issue or pull request conversation, and a commit are each answered as a whole, so a comment steered into a turn in one of those is already in the thread the answer is coming to: nothing is posted there, and the answer arriving is what shows it landed. So is a GitHub review comment steered into a turn that started in the same review thread — an answer to a review comment is posted as a reply in the thread that comment is in, which is the thread this one is reading — as long as [the payload](#forking-a-review-thread) says which thread they are both in. Where it does not, the pointer is posted anyway.

|                                                               |                                                                                                                       |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Several comments while it works                               | Each reaches the turn, in the order they arrived.                                                                     |
| A comment from somebody else                                  | Steers it just the same, and the agent is told who wrote it.                                                          |
| While a turn is waiting on a permission request or a question | That comment is [the answer](#how-to-answer) instead. A waiting turn needs answering, and one comment cannot be both. |
| With a setting that is a start-up flag                        | Waits and runs as a turn of its own, because taking it on means restarting `claude`.                                  |
| With `[progress=...]` or `[askTimeoutSeconds=...]`            | Taken on at once and folded into this turn, since neither is a flag `claude` was started with.                        |
| With `[stop]` or `[exit]`                                     | Stops the turn or ends the process, as it does anywhere else.                                                         |
| With `[clear]` or `[compact]`                                 | Waits and runs as a turn of its own, because both are about the history this turn is still writing.                   |
| With `[fork]`                                                 | [Forks](#forking-a-review-thread) the review thread it was written in and runs there, leaving this turn to carry on.  |
| While the process is starting again after a settings change   | Waits and runs as its own turn, rather than being written to a process that cannot take it.                           |

**A steer is not guaranteed to land before a `[stop]`.** Nothing comes back from Claude Code to say a mid-turn message was taken, so a `[stop]` written moments after one may cancel it along with the turn, without saying which. Stopping sooner matters more than keeping the steer, so that is the trade this makes: if it mattered, say it again once the turn has stopped.

**One turn is one answer.** Two comments folded into the same turn get one reply between them, posted under the comment that started the turn, rather than a reply each. The others get the notice above when that reply lands out of their sight, and nothing at all when it lands in the thread they were written in.

## Stopping a turn

A turn already running can be called off from the thread, with the same bracketed group, using any of these words:

```
interrupt   stop   int
```

```
@my-bot [stop]
@my-bot [stop] look at the release branch instead, not main
```

The `claude` process is interrupted where it stands. It is not killed and the session is not lost: the thread keeps its history and the next mention carries on from there. To end the process itself, see [Ending the process](#ending-the-process).

|                                                                                  |                                                                                                                                                                              |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| While a turn is running                                                          | It is stopped. Whatever the agent had already said is posted, followed by `Stopped, as asked.`                                                                               |
| While a turn is waiting on a permission request or a question                    | It is stopped too. The tool does not run. This is the one group that is read while something is waiting, rather than being taken as the answer.                              |
| While nothing is running                                                         | Nothing to do, and the bot says so. A turn that finished a moment before the comment arrived reads this way.                                                                 |
| With an instruction after it                                                     | The instruction runs as the next turn, once the stopped one has finished stopping. Anything already waiting for a turn of its own still runs first, in the order it arrived. |
| With settings after it                                                           | `[interrupt, model=opus] try again` stops the turn and applies the settings to the one that replaces it.                                                                     |
| With something [steered](#steering-a-running-turn) into the turn moments earlier | That may go with the turn, unacknowledged, since nothing says whether it had landed yet. Stopping sooner is the trade this makes.                                            |

## Ending the process

The `claude` process itself can be ended from the thread, with the same bracketed group, using either of these words:

```
exit   quit
```

```
@my-bot [exit]
@my-bot [exit] now have another go at it
```

The process is stopped where it stands, and whatever it was doing goes with it. The session is not lost: the next mention in the thread starts a process again on the same session, so it still has everything said before. Reach for this when the process is wedged, or when it was started from a `claude` you have upgraded since. Reach for [`[stop]`](#stopping-a-turn) when it is only the turn you want rid of, and [`[clear]`](#clearing-the-context) when it is the thread's history: the session outlives this, and everything said in it comes back with the next mention.

|                                                               |                                                                                                                                                                         |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| While a turn is running                                       | It goes with the process. Whatever the agent had already said stays posted, and the end is not reported as a failure.                                                   |
| While a turn is waiting on a permission request or a question | It goes too, and the tool does not run. Like `[stop]`, this is read while something is waiting rather than being taken as the answer.                                   |
| While the process is not running                              | Nothing to do, and the bot says so. A thread whose session mention-forwarder has already closed for being idle reads this way.                                          |
| With an instruction after it                                  | The instruction runs as the next turn, in the process that replaces this one. Anything already waiting for a turn of its own still runs first, in the order it arrived. |
| With settings after it                                        | `[exit, model=opus] try again` ends the process and applies the settings to the one that replaces it.                                                                   |

## Clearing the context

A thread's history can be thrown away from the thread, with the same bracketed group, using this word:

```
clear
```

```
@my-bot [clear]
@my-bot [clear] read the pull request again from the top
```

This is `/clear`. The `claude` process ends and the session is forgotten, so the next mention here opens one of its own that starts out knowing nothing of what was said before it: not this thread's earlier turns, and not [the thread it came out of](#threads-that-come-out-of-other-threads). Anything the agent wrote to disk it wrote to disk; this is the conversation and nothing else. The thread's model and effort are not history and stay as they are.

Reach for this when a thread has gone somewhere you would rather it forgot, or when it has drifted far enough that starting over beats explaining. Reach for [`[compact]`](#compacting-the-context) when the history is worth keeping and only its size is the problem.

|                                                               |                                                                                                                                                                       |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| While a turn is running                                       | It waits for that turn to finish rather than joining it, and takes its place behind anything already waiting for a turn of its own.                                   |
| While a turn is waiting on a permission request or a question | That comment is [the answer](#how-to-answer) instead. Only `[stop]` and `[exit]` are read while something is waiting.                                                  |
| While nothing has run in the thread yet                       | Nothing to clear, and the bot says so.                                                                                                                                |
| With an instruction after it                                  | It runs as the next turn, in the new session, and is what that session opens with.                                                                                    |
| With settings after it                                        | `[clear, model=opus] start again` applies both, and says both.                                                                                                        |
| Later, in another process                                     | Still cleared. A thread that threw its history away is recorded as having done so, so the work it came out of is not forked back into the gap the next time it starts. |

## Compacting the context

The same bracketed group, keeping a summary rather than nothing:

```
compact
```

```
@my-bot [compact]
@my-bot [compact] now go on to the tests
```

This is `/compact`. Claude Code summarizes the session so far and carries on from that summary, in the same session, so the thread keeps its place and its id. No turn is run, so what the thread gets back is what became of its history:

> Compacted this thread's context: everything said here so far is a summary of itself now, and the thread carries on from that. 29,169 tokens of it became 1,193.

A session that fills up is compacted by Claude Code on its own, without being asked and without the thread hearing about it. This is for doing it deliberately, before a long thread gets there.

|                                                               |                                                                                                                                        |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| While a turn is running                                       | It waits for that turn to finish, as `[clear]` does, so it summarizes the whole of what has been said and not part of it.              |
| While a turn is waiting on a permission request or a question | That comment is [the answer](#how-to-answer) instead.                                                                                  |
| While the process is not running                              | It is started on the thread's own session and compacts that, since compacting is something you ask for before the next turn, not after. |
| While nothing has run in the thread yet                       | Nothing to compact, and the bot says so.                                                                                               |
| When there is too little of it to be worth summarizing        | Claude Code refuses, and the thread is told what it said: `Not enough messages to compact.`                                            |
| With an instruction after it                                  | It runs as the next turn, once the compaction has finished, so it runs on what the compaction left.                                    |

## Forking a review thread

One GitHub review thread can be taken out of the pull request it is on and given a session of its own, with the same bracketed group, using this word:

```
fork
```

```
@my-bot [fork]
@my-bot [fork] work out whether this breaks the importer
```

Every review comment on a pull request reaches the bot as part of that pull request's conversation: one session for all of them, and one turn at a time, however many threads are open on the diff. Written in a review comment, `[fork]` takes the thread it is in out of that. From then on the thread has a session of its own — opened as a copy of the pull request's, so it knows everything said there up to this point — and a `claude` of its own running beside it, so two review threads can be answered at once with neither waiting on the other. Nothing said in the thread from here reaches the pull request's own thread or the other threads on it, and nothing said in those reaches it.

Nothing is posted to say it happened. `[fork] have a look` comes back as the answer to "have a look" and nothing else, and `[fork]` on its own comes back as no comment at all: the fork is what the comment asked for, so a line saying so would only ever sit on top of the answer to the same comment. The log says it, and [the list of what is running](#seeing-what-is-running) grows a row for the new thread.

What the thread does hear about is a fork that gave it something other than what it asked for. One that found no session to copy says so, because the new thread starts knowing nothing of the pull request:

> There was nothing to copy into this review thread: nothing has run in this pull request's own thread yet, so there was no session to fork. The thread has one of its own from here all the same, and it starts knowing only what is written in it.

So does one that was refused outright — a thread that already has a session, a comment that is not in a review thread, a review comment that cannot be placed in one.

Every later mention in that thread runs there, group or no group, and its answers are posted as replies in it, which is where mention-forwarder answers a review comment anyway. This is the same forking as [Threads that come out of other threads](#threads-that-come-out-of-other-threads), asked for from the thread rather than earned by opening a pull request, and it is remembered the same way: the thread keeps its session when the process for it has gone.

|                                                               |                                                                                                                                                                                       |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A thread that has already been forked                         | Nothing to do, and the bot says so. Forking it again would start a second session on a thread whose first is already answering it, knowing only the half it had seen.                 |
| A thread that has not been forked                             | Nothing said in it, and no comment back. The fork is made and the thread is answered by it from then on.                                                                              |
| Anywhere but a review comment                                 | Nothing to fork, and the bot says so. The comment is answered in the thread as it always was.                                                                                         |
| While a turn is running on the pull request                   | The fork is made and starts its own turn at once. That is the point: the pull request's turn carries on untouched.                                                                     |
| While a turn is waiting on a permission request or a question | The fork is made, and the request goes on waiting for somebody to answer it. `[fork]` is read while something is waiting, as `[stop]` and `[exit]` are.                                |
| With an instruction after it                                  | It runs as the new session's first turn, and is what that session opens with.                                                                                                         |
| With settings after it                                        | `[fork, model=opus] have a look` applies them to the new thread, leaving the pull request's own on whatever it was.                                                                    |
| Before anything has run on the pull request                   | There is no history to copy, so the thread starts a session of its own knowing only what is written in it, and the bot says so.                                                       |
| With `[stop]`, `[exit]`, `[clear]` or `[compact]`             | Refused rather than guessed at: forking is about a thread of its own, and those four are about the thread the comment was written in.                                                  |

**Two agents in one working directory.** A forked thread's `claude` runs in the same `cwd` as the thread it came out of, and neither knows the other is there — and on a busy pull request that is one directory between the pull request's own thread and every review thread forked off it. Each forked session is [told so](#what-the-agent-is-told), and told that the worktree in the history it inherited is not its own, which is a request and not a fence: where it matters, say it again in [your own standing instructions](#telling-it-something-of-your-own).

**It needs the webhook payload.** Which review thread a comment belongs to is the one thing a mention does not otherwise say: a reply's permalink names the reply, not the thread it is in, and only `in_reply_to_id` in GitHub's payload ties the two together. So this needs mention-forwarder's `includeRawPayload`:

```json
{ "includeRawPayload": true }
```

Without it a review comment cannot be placed in a thread at all, and `[fork]` says so rather than forking a thread it would then lose track of. Nothing else here reads the payload.

## Settings

Anything you would otherwise pass as a flag can live in `mention-forwarder-claude-code.config.json`, read from the directory mention-forwarder starts the command in, or from `--config <path>`. Only a file named with `--config` has to exist.

```json
{
  "$schema": "./mention-forwarder-claude-code.config.schema.json",
  "model": "opus",
  "effort": "high",
  "approval": "ask",
  "permissionMode": "acceptEdits",
  "progress": "all"
}
```

| Setting              | Same as                                                        | A thread can change it |
| -------------------- | -------------------------------------------------------------- | ---------------------- |
| `binary`             | `--binary`                                                     | Yes                    |
| `cwd`                | `--cwd`, a path taken relative to the config file              | No                     |
| `model`              | `--model`                                                      | Yes                    |
| `effort`             | `--effort`                                                     | Yes                    |
| `permissionMode`     | `--permission-mode`                                            | Yes                    |
| `approval`           | `--approval`                                                   | Yes                    |
| `appendSystemPrompt` | `--append-system-prompt`                                       | Yes                    |
| `allowedTools`       | `--allowed-tools`                                              | Yes                    |
| `disallowedTools`    | `--disallowed-tools`                                           | Yes                    |
| `addDirs`            | `--add-dir`, a list of paths taken relative to the config file | Yes                    |
| `claudeArgs`         | `--claude-arg`, a list                                         | Yes                    |
| `progress`           | `--progress`                                                   | Yes                    |
| `askTimeoutSeconds`  | `--ask-timeout`                                                | Yes                    |
| `webPort`            | `--web-port`                                                   | No                     |
| `stateFile`          | `--state-file`, a path taken relative to the config file       | No                     |
| `patternsFile`       | `--patterns`, as above                                         | No                     |
| `recordFile`         | `--record`, as above                                           | No                     |
| `logLevel`           | `--log-level`                                                  | No                     |

The last column is [a group in a mention](#settings-a-thread-can-change), which puts one thread on a setting for as long as it lasts. The six that say No belong to the whole process: it runs every conversation active on this machine at once, and they are shared with all of them or settled before any of them started.

**A flag wins over the file, which wins over the built-in default.** A misspelled setting is refused at startup rather than ignored, and so is one of the wrong type.

[mention-forwarder-claude-code.config.example.json](./mention-forwarder-claude-code.config.example.json) spells out every setting with a value, rather than the handful above, so copy it and delete whatever you do not need. Nothing in it is required. Three of its settings name a file, and their relative paths are taken from wherever you put your copy: `stateFile` and `recordFile` are created for you, but `patternsFile` has to point at a module that exists, so delete that line unless you have written one.

### Descriptions while you write it

That `$schema` line is what makes an editor describe the file to you. [mention-forwarder-claude-code.config.schema.json](./mention-forwarder-claude-code.config.schema.json) is a JSON Schema of every setting, so VS Code, and anything else that reads one, will complete the keys, show what each one means and what it takes when you hover it, and mark a misspelled key or an invalid value while you type rather than at startup. `$schema` is the one key here that is not a setting: the program accepts it and ignores it.

The path is taken relative to the config file itself, so what you write depends on where yours sits next to this checkout:

```json
{
  "$schema": "../mention-forwarder-client-claude-code-cli/mention-forwarder-claude-code.config.schema.json"
}
```

## Sessions that outlive the process

Which Claude Code session belongs to which conversation is remembered in a small JSON file, by default `~/.local/state/mention-forwarder-claude-code/sessions.json` (or under `XDG_STATE_HOME`). It is what lets a thread keep its history when the process for it has gone: an idle session closed by mention-forwarder, a forwarder restart, a machine reboot. The thread's model and effort live there too.

Entries are only reused for the same working directory, because Claude Code files a session under the directory it ran in. A session that will no longer open is replaced with a new one, once, and the thread starts over rather than failing. `--no-state` turns the file off entirely, which means each new process starts a new session.

### Threads that come out of other threads

A thread that ends in a pull request has a second thread coming: the pull request's own. It is a different `conversationKey`, so by default a different session, and the agent answering `@bot` there starts knowing nothing about the work it is being asked about. Instead, the session that did the work is **forked** into that thread, and the answer comes from an agent with the whole of the first thread behind it.

It takes both halves. The agent writes the pull request down: its system prompt asks it, as soon as the pull request exists, to append one line to a file that sits beside the state file — `~/.local/state/mention-forwarder-claude-code/forks/forks.jsonl` unless `--state-file` says otherwise:

```json
{ "url": "https://github.com/acme/widgets/pull/12", "from": "slack:T024BE7LD:C0G9QF9GW:1755973451.000100" }
```

`url` is the pull request it just opened and `from` is its own conversation, filled into the request for it. That directory, and nothing else of the state, is handed to `claude` as one the agent may write in, so recording a pull request is not a permission request posted back to the thread. Nothing in this program ever writes there: a line is a claim by whoever wrote it, the file is only ever appended to, and the newest line claiming a url wins.

The next process reads it. A mention whose url is a recorded pull request, or anything under one, starts `claude` with `--resume=<the session of the thread that recorded it> --fork-session`: that history is copied into a session of its own, which is this thread's from then on. The thread it came out of keeps its own session and carries on untouched, which is why this forks rather than resumes — two threads writing into one session would each find the other's turns in their history. The first message of a forked session says so, because everything above it was said somewhere else, to people who cannot see this thread.

A forked thread also starts on whatever settings the thread it came from had taken on, so the pull request is answered by what did the work rather than by the defaults, and they are then remembered under the new thread's own key. Anything the new thread had already settled for itself with a group of its own stays as it is; only what it had not chosen comes across.

A thread that has [cleared its own history](#clearing-the-context) is never forked into, whichever process it next starts in: having no session is exactly the gap a fork fills, and filling it would hand back the history the thread had just asked to be rid of.

A review thread on a pull request can ask for the same thing from the thread itself, rather than being handed it on the way in: see [Forking a review thread](#forking-a-review-thread). It forks the same way, off the session the pull request is on, and is remembered under a key of its own beneath the pull request's.

Urls are matched without their fragment, query or case, so a comment permalink (`…/pull/12#issuecomment-9`), a review comment (`…#discussion_r7`) and a file view (`…/pull/12/files`) all name the same pull request. Nothing prunes the file, and a line in it is only ever read for a conversation that has no session of its own yet.

Forking goes through the same store as everything else, so the rules above hold: a session remembered for another working directory is not forked, and one that will no longer open leaves the new thread to start on its own instead of failing. `--no-state` turns this off along with the rest.

## Seeing what is running

<http://127.0.0.1:4100> lists every conversation with a process on this machine right now, and links each one back to the thread it came from. It refreshes itself every two seconds, and there is nothing to click but the links: it reads, and never asks the bot to do anything. Another device on the same network can open it too, at this machine's address there; [what can reach it](#what-can-reach-it) is below.

One row per conversation — a process that is running a [forked review thread](#forking-a-review-thread) has a row for it as well as for the pull request it came out of — showing:

| Shown                                     | Read as                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `RUNNING`, `WAITING`, `IDLE`              | A turn is under way; a turn has stopped for a [permission request or a question](#approvals-and-questions); nothing is running.       |
| The title, linked                         | The issue or PR title, or the Slack channel. The link is the comment that most recently mentioned the bot there.                      |
| `Working for 2m 14s, steered 1×`          | How long this turn has been going, and how many comments were [steered](#steering-a-running-turn) into it.                            |
| `Waiting on Bash for 40s`                 | Which tool, or a question it asked, and how long it has been waiting for somebody to answer in the thread.                            |
| The model and effort                      | The thread's own, including whatever a [`[model=...]` group](#settings-a-thread-can-change) has changed them to.                      |
| `3 turns of 5 mentions`, `1 queued`       | What this process has done since it started, and how many mentions are waiting for a turn of their own.                               |
| The working directory, and the session id | The checkout the agent is working in, and the first characters of the Claude Code session, which is enough to find it under `~/.claude/projects`. |
| `what it has been doing`                  | A link to [everything that session has done](#everything-a-session-has-done), which is where the work between replies is legible.                 |

mention-forwarder runs one process per conversation, so no single one of them can see the others. Each publishes what it is doing to `~/.local/state/mention-forwarder-claude-code/live/<pid>.json` (or under `XDG_STATE_HOME`), and they all try for the port: whichever gets it serves the list for all of them, and the rest keep trying every ten seconds, so the view survives that process going away. A file left behind by a process that was killed outright is dropped by the next reader.

`http://127.0.0.1:4100/conversations.json` is the same list as JSON, if you would rather watch it from a script.

### Everything a session has done

**A thread is only ever shown what the agent says, and under `--progress final` not even that until the turn is over.** Following `what it has been doing` on a conversation's row opens the whole session instead, in the order it happened: what each mention asked, what the agent answered, every tool it called and with what, what came back, and the errors Claude Code retried past. It keeps up with a running turn, appending as the session is written, and stays at the end as long as you are already there.

What it shows is Claude Code's own transcript, the `~/.claude/projects/<project>/<session id>.jsonl` (or under `CLAUDE_CONFIG_DIR`) that `claude --resume` reads. This only ever reads it.

| Shown                  | Read as                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `From the thread`      | A mention, worded as the agent was given it, which on the first one is [the whole opening message](#what-the-agent-is-told). |
| `The agent`            | What it said. Under `--progress all` the thread was posted this as it arrived; under `final`, only the last of it.    |
| `Bash`, `Read`, `Edit` | A tool call, under the tool's own name, with the arguments it was called with.                                        |
| `↳ Bash`               | What that call came back with, marked `failed` when the tool called it an error.                                      |
| `subagent`             | Work a `Task` did off to the side of the thread, which reaches the thread only through whatever the agent makes of it. |
| `Claude Code`          | The CLI itself: a dropped connection it retried past, and anything else it wrote down as an error.                    |

A block over 20,000 characters is cut there and says how much it dropped, so one read of a large file cannot become the whole page, and anything over a screenful is folded until you ask for the rest.

Only a session the list already names can be opened, and only while its conversation still has a process: this view has no password, and a transcript is a great deal more than a title.

`http://127.0.0.1:4100/session.json?id=<session id>` is the same thing as JSON. `&from=<byte offset>` asks only for what the file has gained since that point, which is how the page follows a running turn without re-reading it.

### Keeping it up between threads

**A conversation's process only exists between its first mention and `sessionIdleMs` after its last**, so a view served by one of those is only up while there is a thread to serve it — and gone the rest of the time, which is when you are most likely to open it. `--web-only` is a process that serves the list and reads no mentions:

```sh
mention-forwarder-claude-code --config your-config.json --web-only
```

Run one beside mention-forwarder and the list is there whether anything is running or not, including to tell you that nothing is. It publishes nothing of its own — it only reads what the conversations publish — and a conversation that finds the port taken carries on without a view of its own, as it does when another conversation has it. [run.sh](./run.sh) starts one for you.

### What can reach it

It listens on every interface and decides per request, so this machine's own address on the network works as well as loopback: `http://192.168.1.218:4100` from your phone on the same wifi, or the machine's own name, or `http://127.0.0.1:4100` here.

| A request from                                                      | Answered            |
| ------------------------------------------------------------------- | ------------------- |
| Loopback: `127.0.0.0/8`, `::1`                                      | Yes                 |
| A private range: `10/8`, `172.16/12`, `192.168/16`, IPv6 `fc00::/7` | Yes                 |
| Link-local: `169.254/16`, `fe80::/10`                               | Yes                 |
| `100.64/10`, the shared range Tailscale and the like hand out       | Yes                 |
| Anywhere else                                                       | No, and it is logged |

A request whose `Host` header is neither a local address nor a name this machine goes by is refused as well, so a hostname somebody else's DNS points here cannot read it through a browser that can.

**It has no password**, so treat it as readable by anything on the network you are on, and by anyone on this machine: thread titles, working directories, session ids, and [everything the running sessions have done](#everything-a-session-has-done), which is every file they read and every command they ran. Do not put it behind a tunnel or a reverse proxy.

`--web-port 0`, or `"webPort": 0`, turns the whole thing off, publishing included. Use it on a network you would not hand this list to.

## Options

| Option                          | Default                                                      | Meaning                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-c`, `--config <path>`         | `mention-forwarder-claude-code.config.json` when it exists   | The [settings file](#settings).                                                                                                                         |
| `--binary <path>`               | `claude`                                                     | The program to run. Use an absolute path if mention-forwarder's `PATH` is not your shell's.                                                             |
| `--cwd <path>`                  | this process's own                                           | Directory to run `claude` in. mention-forwarder's `cwd` already sets this, so it is only needed to point somewhere else.                                |
| `--model <name>`                | the CLI's own default                                        | Model new threads start on.                                                                                                                             |
| `--effort <level>`              | the CLI's own default                                        | `low`, `medium`, `high`, `xhigh`, or `max`.                                                                                                             |
| `--permission-mode <mode>`      | the CLI's own default                                        | Passed to `claude`: `default`, `acceptEdits`, `plan`, `dontAsk`, `auto`, or `bypassPermissions`.                                                        |
| `--approval <mode>`             | `ask`                                                        | What to do when the agent asks. See [Approvals and questions](#approvals-and-questions).                                                                |
| `--append-system-prompt <text>` |                                                              | Instructions added to the end of the system prompt every thread starts with. See [Telling it something of your own](#telling-it-something-of-your-own). |
| `--allowed-tools <list>`        |                                                              | Passed to `claude`, e.g. `"Read Grep Bash(git *)"`.                                                                                                     |
| `--disallowed-tools <list>`     |                                                              | Passed to `claude`.                                                                                                                                     |
| `--add-dir <path>`              |                                                              | Another directory the agent may touch. Repeatable.                                                                                                      |
| `--claude-arg <arg>`            |                                                              | Passed to `claude` untouched, after everything this program sets. Repeatable. Use `--claude-arg=--flag` when the argument starts with a dash.           |
| `--progress <mode>`             | `all`                                                        | `all` posts what the agent says as it says it; `final` posts only its answer. Either way, a request the turn stops on is posted with what led to it.    |
| `--ask-timeout <seconds>`       | `0`                                                          | Refuse a waiting request if nobody answers in this long. `0` waits forever.                                                                             |
| `--state-file <path>`           | `~/.local/state/mention-forwarder-claude-code/sessions.json` | Where conversation-to-session ids are remembered. The `forks` directory beside it is where a thread records the pull requests it opens.                 |
| `--no-state`                    | off                                                          | Remember nothing, and let no thread fork another.                                                                                                       |
| `--web-port <port>`             | `4100`                                                       | Where the [web view](#seeing-what-is-running) is served, to local addresses only. `0` serves nothing.                                                    |
| `--web-only`                    | off                                                          | Serve that view and read no mentions, until stopped. For running one beside mention-forwarder.                                                           |
| `--patterns <path>`             |                                                              | A module that patches how `claude`'s output is read. See below.                                                                                         |
| `--record <path>`               |                                                              | Append every raw event from `claude` here.                                                                                                              |
| `--log-level <level>`           | `info`                                                       | `debug`, `info`, `warn`, or `error`. `debug` adds thinking, tool results, and every event no pattern claimed.                                           |
| `-h`, `--help`                  |                                                              | Show the options.                                                                                                                                       |

Mentions arrive on stdin, so nothing has to be passed through `command` or `env` in mention-forwarder. Placeholders such as `{{prompt}}` are fixed at spawn time under `per-conversation` and would go stale after the first mention, which is why this program does not read them.

## How it talks to claude

One `claude` process per conversation, started like this:

```
claude --print
       --input-format stream-json --output-format stream-json --verbose
       --permission-prompt-tool stdio
       [--resume=<session id>] [--fork-session] [--model …] [--effort …] [--permission-mode …]
       --append-system-prompt <the framing above>
```

Those first six arguments are what make the protocol work. `--print` with stream-json in both directions gives one JSON object per line each way, and the process stays alive between turns, so a conversation is a sequence of messages on one stdin rather than one process per mention. `--permission-prompt-tool stdio` is what turns a permission prompt into a `control_request` this program answers, instead of the CLI refusing it on its own and carrying on.

What travels each way:

| Direction | Frame                                                                                                                   | Meaning                                                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| in        | `{"type":"user","message":{"role":"user","content":[{"type":"text","text":…}]}}`                                        | Run this as a turn.                                                                                                                                              |
| in        | `{"type":"control_request","request_id":…,"request":{"subtype":"initialize"}}`                                          | Sent once at startup. Without it the CLI runs in a reduced mode where `AskUserQuestion` is not offered to the model.                                             |
| in        | `{"type":"control_response","response":{"subtype":"success","request_id":…,"response":{"behavior":"allow"\|"deny",…}}}` | The answer to an ask.                                                                                                                                            |
| out       | `{"type":"system","subtype":"init",…}`                                                                                  | Start of a turn; carries the session id.                                                                                                                         |
| out       | `{"type":"assistant","message":{"content":[…]}}`                                                                        | One or more finished content blocks: prose, thinking, or a tool call.                                                                                            |
| out       | `{"type":"user","message":{"content":[{"type":"tool_result",…}]}}`                                                      | What a tool returned.                                                                                                                                            |
| out       | `{"type":"control_request","request":{"subtype":"can_use_tool",…}}`                                                     | The turn has stopped and needs a decision. `requires_user_interaction` marks the ones whose own card is the question, which in practice means `AskUserQuestion`. |
| out       | `{"type":"result","subtype":"success",…}`                                                                               | The turn is over. Carries the last thing the model said and anything it was not allowed to run. One reporting `"num_turns":0` with nothing to say ends a prompt the CLI queued for itself, not one sent from here, and is ignored.                                                                  |

Everything on stdout is read as newline-delimited JSON; anything else is logged as a warning rather than parsed. stderr is logged and never posted.

The same events are also written to `~/.claude/projects/<slugified cwd>/<session id>.jsonl`, which is worth knowing when you want to look at a thread after the fact. This program reads stdout instead, because that is the only side of the connection an answer can be sent back over.

## Pattern detection

Nothing outside `src/patterns.ts` touches a raw event. Each one is passed through an ordered list of rules, and the first rule that claims it returns what it means as [signals](./src/signals.ts): `session`, `text`, `tool-start`, `ask`, `turn-end`, and so on. A rule is small enough to read in one go:

```ts
const permissionDenied: Rule = {
  name: "system/permission-denied",
  shape: `{"type":"system","subtype":"permission_denied","tool_name":…}`,
  match(event) {
    if (event["type"] !== "system" || event["subtype"] !== "permission_denied") return null;
    return [{ kind: "auto-denied", toolName: str(event["tool_name"]) ?? "a tool", … }];
  },
};
```

`null` means "not mine, try the next rule". An empty array means "mine, and it means nothing", which is how noise is claimed rather than dropped. Every field is read through accessors that return a default instead of throwing, so an event whose shape has drifted degrades rather than crashing the bot.

**An event no rule claims is logged as `no pattern matched an event`, with the event.** That warning is the signal that a `claude` release has moved something. Three things help when it happens:

1. `--record <path>` appends every raw event to a file, so you can see the real shape rather than a truncated log line.
2. `--patterns <path>` names a module whose default export is handed the built-in rules and returns the ones to use. Put a rule in front of a built-in one to replace it, or on the end to claim something new. [patterns.example.mjs](./patterns.example.mjs) shows both.
3. `test/patterns.test.ts` holds a copy of every event shape this was built against, taken from real runs. Adding the new shape there pins it.

A patterns file needs no build step and no reinstall, so a release that breaks something can be patched in place and folded back into `src/patterns.ts` afterwards.

## Troubleshooting

| Symptom                                                                       | Cause                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Unknown file extension ".ts"`                                                | Node is older than 22.18. Check with `node --version`.                                                                                                                                                                                                   |
| `claude failed to start: spawn claude ENOENT`                                 | `claude` is not on the `PATH` mention-forwarder was started with. Set `--binary` to its absolute path.                                                                                                                                                   |
| `I could not start Claude Code` posted to the thread                          | The process left before it was ready. Its stderr is in this command's log, prefixed by mention-forwarder.                                                                                                                                                |
| Nothing is ever posted, but the reaction appears                              | The turn said nothing, which a tool-only turn can do. Run with `--log-level debug`.                                                                                                                                                                      |
| Nothing is posted for a whole turn, and the log says `a turn ended that this program did not start` | Something ended a turn this program was not running, and everything the real turn went on to say had nowhere to go. The one known cause — the CLI queuing a task notification of its own when it resumes a session that left background work behind — is recognized and logged as `ignored a turn end` instead, so this warning means a `result` whose shape it does not recognize. See [Pattern detection](#pattern-detection). |
| The agent says it lacks permission and nothing was posted asking for it       | `--approval` is `deny`, or `--permission-mode` is `dontAsk`.                                                                                                                                                                                             |
| A permission request is posted but replying does nothing                      | Replies only answer it while the same process is alive. If mention-forwarder closed the session first (`sessionIdleMs`), the request is gone; the reply is run as a new turn.                                                                            |
| Every mention starts a new session                                            | `--no-state` is set, `cwd` changed between runs, or the state file is not writable (that is logged as a warning).                                                                                                                                        |
| Replies arrive in pieces                                                      | Expected: progress is posted as the agent produces it. Raise `replyDebounceMs` in mention-forwarder to gather more of it per comment, or pass `--progress final`.                                                                                        |
| `no pattern matched an event` in the log                                      | A `claude` release changed a shape. See [Pattern detection](#pattern-detection).                                                                                                                                                                         |
| A second mention is answered only after the first finishes                    | Expected when it carried a setting that is a start-up flag, such as `[model=…]` or `[effort=…]`, which needs a turn of its own. Otherwise it should have reached the running turn: look for `steering the running turn` in the log. See [Steering a running turn](#steering-a-running-turn).        |
| A comment written while it was working seems to have been ignored             | If the log says `steering the running turn`, it reached the agent and the agent chose what to do with it; nothing here can force its hand, so say it again as its own mention. If it says `queued behind the running turn`, it needed a turn of its own. |
| The turn failed with a model error                                            | The `[model=…]` group named something `claude` cannot use. What `claude` said is posted to the thread.                                                                                                                                                   |
| A `[…=…]` group reached the agent as text instead of changing the thread      | It was not the first thing in the mention, one of its parts named neither a setting nor one of the bare words this program knows, or it was answering a waiting request. See [Settings a thread can change](#settings-a-thread-can-change).              |
| A group said the setting is settled for the whole process                     | It is one of `cwd`, `stateFile`, `patternsFile`, `recordFile`, `webPort` or `logLevel`, which are shared by every conversation this process is running. Change it in the config file or with its flag. See [Settings a thread can change](#settings-a-thread-can-change). |
| `[stop]` did nothing but post a line saying nothing was running               | The turn had already finished by the time mention-forwarder delivered the comment. See [Stopping a turn](#stopping-a-turn).                                                                                                                              |
| `[exit]` did nothing but post a line saying nothing was running               | There was no `claude` process to end: mention-forwarder had closed the session for being idle, or it had already gone. The next mention starts one. See [Ending the process](#ending-the-process).                                                       |
| `[fork]` says it cannot tell which review thread the comment is in            | mention-forwarder is not passing the webhook payload on, which is the only thing that says. Set `includeRawPayload` in its config. See [Forking a review thread](#forking-a-review-thread).                                                              |
| `[compact]` came back with `Not enough messages to compact`                   | Claude Code will not summarize a session with almost nothing in it. Nothing was lost and the thread carries on as it was. See [Compacting the context](#compacting-the-context).                                                                         |
| A cleared thread still knows the work behind its pull request                 | Clearing is remembered across processes, so this should not happen. Look for `not forking into a thread that has been cleared` in the log. See [Clearing the context](#clearing-the-context).                                                            |

## Development

```sh
npm test        # unit tests, plus an end-to-end run of the real CLI against a stand-in claude
npm run typecheck
```

`test/stub-claude.mjs` speaks enough of the protocol to script a run, so the whole pipeline is covered without a model or a network. The event shapes in `test/patterns.test.ts` are copied from real `claude` output.

| Path                   | Role                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------- |
| `src/cli.ts`           | Entry point: options, wiring, the stdin loop, stop signals.                                 |
| `src/options.ts`       | Flags and config file resolved into one checked object.                                     |
| `src/config-file.ts`   | Reading and checking the settings file.                                                     |
| `src/mention.ts`       | The mention shape, and reading them off stdin.                                              |
| `src/claude.ts`        | The `claude` process: argv, framing, and the control protocol.                              |
| `src/patterns.ts`      | What each event means. The one place a shape is read.                                       |
| `src/signals.ts`       | The vocabulary the rest of the program thinks in.                                           |
| `src/conversation.ts`  | One thread: which mention starts a turn, which answers an ask, and what gets posted.        |
| `src/message.ts`       | What the agent is told, and what the thread sees.                                           |
| `src/directive.ts`     | The `[setting=…, interrupt, exit, clear, compact]` group at the start of a mention.          |
| `src/settings.ts`      | Which settings a thread may take on, what each takes, and why the rest belong to the process. |
| `src/answer.ts`        | Whether a reply means "go ahead".                                                           |
| `src/reply.ts`         | Appending to the mention's reply file.                                                      |
| `src/session-store.ts` | Remembers which session belongs to which conversation.                                      |
