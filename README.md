# mention-forwarder-client-claude-code-cli

Runs the @-mentions that [mention-forwarder](https://github.com/suchipi/mention-forwarder) picks up from GitHub, Slack, and Linear as turns in a [Claude Code](https://claude.com/claude-code) session, and posts what the agent says back to the thread the mention came from.

It drives the `claude` binary itself, over the stream-json protocol that binary already speaks, so it runs on whatever `claude` is logged in as. On a Claude Pro or Max subscription that means the flat fee, not API billing.

```
GitHub  ──┐                       mentions on stdin                  a turn each
Slack   ──┤──▶ mention-forwarder ──────────────────────▶ this ──────────────────▶ claude
Linear  ──┘           ▲                                      ◀──── what the agent said
                      └─────────────── reply file ───────────┘
```

One conversation is one session. Every mention on the same GitHub issue, Slack thread, or Linear issue continues the same Claude Code session, so the agent still knows what it was doing there; mentions in different places never share context. Each thread can also be put on its own model and reasoning effort, by opening a mention with `[model=opus, effort=max]`, a comment written while the agent is working reaches the turn it is working on, and a turn already running can be called off with `[stop]`.

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
from @suchipi via github issue_comment
https://github.com/acme/widgets/issues/7#issuecomment-100

You are answering an @-mention that mention-forwarder picked up. Whatever you say in reply is posted back to that thread as a comment, so write for the people reading it there. Later mentions in the same thread arrive as further turns in this session.

please fix the flaky test
```

Every later mention in that conversation is shorter, because the session already holds everything above:

```
from @suchipi via github issue_comment
https://github.com/acme/widgets/issues/7#issuecomment-101

also update the changelog
```

A few lines are also appended to the session's system prompt, because Claude Code otherwise has every reason to believe it is talking to somebody at a terminal: that its replies are posted as comments, that nobody is at a keyboard, where the thread is, and how long an answer takes to come back. What it says depends on `--approval`.

The thread's link is the mention's own permalink, from whichever mention started the process, and it comes with a note that only the mentions themselves reach the agent, so the rest of the thread is worth reading. A mention that arrives without a permalink leaves the line out.

### Telling it something of your own

`appendSystemPrompt` goes after those lines, at the end of the system prompt, so it is where standing instructions belong: where to do the work, a house style for replies, anything every thread should be told.

```json
{
  "appendSystemPrompt": "Before you change anything, make a git worktree and a branch named after the thread, and do the work there."
}
```

It applies to every thread this process handles, and unlike the model, a thread cannot change it mid-conversation. `--append-system-prompt` is the same thing as a flag.

## What gets posted back

Each finished block of prose from the **main agent** is appended to the mention's reply file, so a long run reports as it goes rather than staying silent. mention-forwarder posts each settled batch, so several blocks close together arrive as one comment and blocks further apart arrive as separate ones. Pass `--progress final` to post only the answer, once the turn is done.

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
> Reply `approve` to allow it. Any other reply refuses it, and what you write is given to the agent as the reason.

A shell command, whose summary of what it does goes in the sentence rather than being named as the thing it acts on:

> The agent needs permission before it can carry on. It wants to run the shell command `git push origin main` (Push the branch).
>
> Reply `approve` to allow it. Any other reply refuses it, and what you write is given to the agent as the reason.

A question:

> The agent has a question:
>
> Do you prefer tabs or spaces for indentation?
>
> - `Tabs`: Use tab characters for indentation
> - `Spaces`: Use space characters for indentation
>
> Reply here with your answer and it will carry on.

### How to answer

**The reply has to be a mention like any other.** mention-forwarder only forwards a comment that triggers it, so an answer that does not is never delivered and the turn goes on waiting:

| Where                     | Write                                                    |
| ------------------------- | -------------------------------------------------------- |
| GitHub, Linear            | `@my-bot approve` (whatever you set as a trigger phrase) |
| A Slack channel or thread | `@my-bot approve`                                        |
| A Slack DM                | `approve`, since a DM needs no mention                   |

**The next mention in that conversation is the answer.** It is not run as a new turn, and whatever the agent goes on to say is posted under that comment rather than under the one that started the turn.

**A question takes an answer in your own words.** Anything you write is handed to the agent, which carries on with it. There is nothing to match and no wrong reply.

**A permission request takes a yes or anything else.** The whole of what you wrote, with the trigger phrase removed, has to be one of these to count as yes:

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

## Choosing the model

Whoever writes the mention picks the model and the reasoning effort, with a bracketed group at the very start of what they wrote:

```
@my-bot [model=opus, effort=max] work out why the deploy hangs
```

The group is read, applied to the thread, and removed; the agent is given only what follows it. Nothing has to be configured for this to work, and it needs no access to the machine the bot runs on.

|                   |                                                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where it goes     | First thing after the trigger phrase, and nothing before it. `look at this [model=opus]` is ordinary text.                                                                               |
| `model`           | Anything `claude --model` takes: an alias like `opus`, `sonnet`, `haiku`, or `fable`, or a full name like `claude-opus-5`.                                                               |
| `effort`          | `low`, `medium`, `high`, `xhigh`, or `max`.                                                                                                                                              |
| Shape             | Comma-separated `name=value` pairs. Either setting may appear alone, in either order. Setting names and effort levels are not case sensitive; a model name is passed through as written. |
| How long it lasts | Every later mention in that thread runs on it too, until another group changes it. It is remembered alongside the session id, so it survives the process going away.                     |

Some examples:

| Written in the thread                  | What happens                                                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@my-bot [model=sonnet] have a look`   | The thread moves to Sonnet and the agent is asked to have a look.                                                                                                      |
| `@my-bot [effort=max]`                 | Nothing but the group, so this is an instruction to the bot alone: the thread moves to maximum effort and it answers with a line saying so, without running the agent. |
| `@my-bot [EFFORT=High, Model=opus] go` | The same as `[effort=high, model=opus] go`.                                                                                                                            |
| `@my-bot [WIP] have a look`            | Ordinary text. `WIP` is not `name=value`, so the whole group is left alone and reaches the agent as written.                                                           |
| `@my-bot [effort=turbo] go`            | `turbo` is not an effort level, so the bot says so in the thread and does not run the mention.                                                                         |
| `@my-bot [model=nonesuch] go`          | Passed to `claude`, which cannot use it. What `claude` says about it is posted to the thread.                                                                          |

Both are start-up flags, so changing one restarts the `claude` process on the same session id. The thread keeps its history. It is also why a group carrying one cannot join a turn already running: a mention that changes the model waits for a turn of its own, where a mention without a group would have been [steered into the running turn](#steering-a-running-turn) instead.

One case where a group is not read: while the agent is waiting on a permission request or a question, the next mention is that answer, so it is handed over as written rather than scanned for settings. Change the model in a mention that starts a turn. The exceptions are [`[stop]`](#stopping-a-turn) and [`[exit]`](#ending-the-process), which are read wherever they appear.

## Steering a running turn

A comment written while the agent is working does not wait for it to finish. It goes to the turn already running, which takes it at its next step — after the tool call or the reply it was part-way through — and answers it as part of that same turn. This is what Claude Code does with a message typed at its prompt mid-turn, and it is what happens here by default. Nothing has to be configured and there is nothing to write:

```
@my-bot actually, check the release branch too
```

The comment that steered it gets a line back, because nothing else would show that it landed:

> The agent is already working here, so this went to it as it runs. It picks this up at its next step and answers as part of the same turn.

From there the turn's output is posted under that comment rather than under the one that started it, the same way [answering a question](#how-to-answer) moves it.

|                                                               |                                                                                                                       |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Several comments while it works                               | Each reaches the turn, in the order they arrived.                                                                     |
| A comment from somebody else                                  | Steers it just the same, and the agent is told who wrote it.                                                          |
| While a turn is waiting on a permission request or a question | That comment is [the answer](#how-to-answer) instead. A waiting turn needs answering, and one comment cannot be both. |
| With `[model=...]` or `[effort=...]`                          | Waits and runs as a turn of its own, because both are start-up flags and take a restart.                              |
| With `[stop]` or `[exit]`                                     | Stops the turn or ends the process, as it does anywhere else.                                                         |
| While the process is starting again after a settings change   | Waits and runs as its own turn, rather than being written to a process that cannot take it.                           |

**A steer is not guaranteed to land before a `[stop]`.** Nothing comes back from Claude Code to say a mid-turn message was taken, so a `[stop]` written moments after one may cancel it along with the turn, without saying which. Stopping sooner matters more than keeping the steer, so that is the trade this makes: if it mattered, say it again once the turn has stopped.

**One turn is one answer.** Two comments folded into the same turn get one reply between them, posted under the later one, rather than a reply each.

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

The process is stopped where it stands, and whatever it was doing goes with it. The session is not lost: the next mention in the thread starts a process again on the same session, so it still has everything said before. Reach for this when the process is wedged, when it is holding onto something you would rather it forgot, or when it was started from a `claude` you have upgraded since. Reach for [`[stop]`](#stopping-a-turn) when it is only the turn you want rid of.

|                                                               |                                                                                                                                                                         |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| While a turn is running                                       | It goes with the process. Whatever the agent had already said stays posted, and the end is not reported as a failure.                                                   |
| While a turn is waiting on a permission request or a question | It goes too, and the tool does not run. Like `[stop]`, this is read while something is waiting rather than being taken as the answer.                                   |
| While the process is not running                              | Nothing to do, and the bot says so. A thread whose session mention-forwarder has already closed for being idle reads this way.                                          |
| With an instruction after it                                  | The instruction runs as the next turn, in the process that replaces this one. Anything already waiting for a turn of its own still runs first, in the order it arrived. |
| With settings after it                                        | `[exit, model=opus] try again` ends the process and applies the settings to the one that replaces it.                                                                   |

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

| Setting              | Same as                                                        |
| -------------------- | -------------------------------------------------------------- |
| `binary`             | `--binary`                                                     |
| `cwd`                | `--cwd`, a path taken relative to the config file              |
| `model`              | `--model`                                                      |
| `effort`             | `--effort`                                                     |
| `permissionMode`     | `--permission-mode`                                            |
| `approval`           | `--approval`                                                   |
| `appendSystemPrompt` | `--append-system-prompt`                                       |
| `allowedTools`       | `--allowed-tools`                                              |
| `disallowedTools`    | `--disallowed-tools`                                           |
| `addDirs`            | `--add-dir`, a list of paths taken relative to the config file |
| `claudeArgs`         | `--claude-arg`, a list                                         |
| `progress`           | `--progress`                                                   |
| `askTimeoutSeconds`  | `--ask-timeout`                                                |
| `webPort`            | `--web-port`                                                   |
| `stateFile`          | `--state-file`, a path taken relative to the config file       |
| `patternsFile`       | `--patterns`, as above                                         |
| `recordFile`         | `--record`, as above                                           |
| `logLevel`           | `--log-level`                                                  |

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

## Seeing what is running

<http://127.0.0.1:4100> lists every conversation with a process on this machine right now, and links each one back to the thread it came from. It refreshes itself every two seconds, and there is nothing to click but the links: it reads, and never asks the bot to do anything. Another device on the same network can open it too, at this machine's address there; [what can reach it](#what-can-reach-it) is below.

One row per conversation, showing:

| Shown                                     | Read as                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `RUNNING`, `WAITING`, `IDLE`              | A turn is under way; a turn has stopped for a [permission request or a question](#approvals-and-questions); nothing is running.       |
| The title, linked                         | The issue or PR title, or the Slack channel. The link is the comment that most recently mentioned the bot there.                      |
| `Working for 2m 14s, steered 1×`          | How long this turn has been going, and how many comments were [steered](#steering-a-running-turn) into it.                            |
| `Waiting on Bash for 40s`                 | Which tool, or a question it asked, and how long it has been waiting for somebody to answer in the thread.                            |
| The model and effort                      | The thread's own, including whatever a [`[model=...]` group](#choosing-the-model) has changed them to.                                |
| `3 turns of 5 mentions`, `1 queued`       | What this process has done since it started, and how many mentions are waiting for a turn of their own.                               |
| The working directory, and the session id | The checkout the agent is working in, and the first characters of the Claude Code session, which is enough to find it under `~/.claude/projects`. |

mention-forwarder runs one process per conversation, so no single one of them can see the others. Each publishes what it is doing to `~/.local/state/mention-forwarder-claude-code/live/<pid>.json` (or under `XDG_STATE_HOME`), and they all try for the port: whichever gets it serves the list for all of them, and the rest keep trying every ten seconds, so the view survives that process going away. A file left behind by a process that was killed outright is dropped by the next reader.

`http://127.0.0.1:4100/conversations.json` is the same list as JSON, if you would rather watch it from a script.

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

**It has no password**, so treat it as readable by anything on the network you are on, and by anyone on this machine: thread titles, working directories, and session ids are in it. Do not put it behind a tunnel or a reverse proxy.

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
| `--progress <mode>`             | `all`                                                        | `all` posts what the agent says as it says it; `final` posts only its answer.                                                                           |
| `--ask-timeout <seconds>`       | `0`                                                          | Refuse a waiting request if nobody answers in this long. `0` waits forever.                                                                             |
| `--state-file <path>`           | `~/.local/state/mention-forwarder-claude-code/sessions.json` | Where conversation-to-session ids are remembered.                                                                                                       |
| `--no-state`                    | off                                                          | Remember nothing.                                                                                                                                       |
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
       [--resume=<session id>] [--model …] [--effort …] [--permission-mode …]
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
| out       | `{"type":"result","subtype":"success",…}`                                                                               | The turn is over. Carries the last thing the model said and anything it was not allowed to run.                                                                  |

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
| The agent says it lacks permission and nothing was posted asking for it       | `--approval` is `deny`, or `--permission-mode` is `dontAsk`.                                                                                                                                                                                             |
| A permission request is posted but replying does nothing                      | Replies only answer it while the same process is alive. If mention-forwarder closed the session first (`sessionIdleMs`), the request is gone; the reply is run as a new turn.                                                                            |
| Every mention starts a new session                                            | `--no-state` is set, `cwd` changed between runs, or the state file is not writable (that is logged as a warning).                                                                                                                                        |
| Replies arrive in pieces                                                      | Expected: progress is posted as the agent produces it. Raise `replyDebounceMs` in mention-forwarder to gather more of it per comment, or pass `--progress final`.                                                                                        |
| `no pattern matched an event` in the log                                      | A `claude` release changed a shape. See [Pattern detection](#pattern-detection).                                                                                                                                                                         |
| A second mention is answered only after the first finishes                    | Expected when it carried `[model=…]` or `[effort=…]`, which needs a turn of its own. Otherwise it should have reached the running turn: look for `steering the running turn` in the log. See [Steering a running turn](#steering-a-running-turn).        |
| A comment written while it was working seems to have been ignored             | If the log says `steering the running turn`, it reached the agent and the agent chose what to do with it; nothing here can force its hand, so say it again as its own mention. If it says `queued behind the running turn`, it needed a turn of its own. |
| The turn failed with a model error                                            | The `[model=…]` group named something `claude` cannot use. What `claude` said is posted to the thread.                                                                                                                                                   |
| A `[model=…]` group reached the agent as text instead of switching the thread | It was not the first thing in the mention, one of its parts was not `name=value` or one of the bare words this program knows, or it was answering a waiting request. See [Choosing the model](#choosing-the-model).                                      |
| `[stop]` did nothing but post a line saying nothing was running               | The turn had already finished by the time mention-forwarder delivered the comment. See [Stopping a turn](#stopping-a-turn).                                                                                                                              |
| `[exit]` did nothing but post a line saying nothing was running               | There was no `claude` process to end: mention-forwarder had closed the session for being idle, or it had already gone. The next mention starts one. See [Ending the process](#ending-the-process).                                                       |

## Development

```sh
npm test        # unit tests, plus an end-to-end run of the real CLI against a stand-in claude
npm run typecheck
```

`test/stub-claude.mjs` speaks enough of the protocol to script a run, so the whole pipeline is covered without a model or a network. The event shapes in `test/patterns.test.ts` are copied from real `claude` output.

| Path                   | Role                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `src/cli.ts`           | Entry point: options, wiring, the stdin loop, stop signals.                          |
| `src/options.ts`       | Flags and config file resolved into one checked object.                              |
| `src/config-file.ts`   | Reading and checking the settings file.                                              |
| `src/mention.ts`       | The mention shape, and reading them off stdin.                                       |
| `src/claude.ts`        | The `claude` process: argv, framing, and the control protocol.                       |
| `src/patterns.ts`      | What each event means. The one place a shape is read.                                |
| `src/signals.ts`       | The vocabulary the rest of the program thinks in.                                    |
| `src/conversation.ts`  | One thread: which mention starts a turn, which answers an ask, and what gets posted. |
| `src/message.ts`       | What the agent is told, and what the thread sees.                                    |
| `src/directive.ts`     | The `[model=…, effort=…, interrupt, exit]` group at the start of a mention.          |
| `src/answer.ts`        | Whether a reply means "go ahead".                                                    |
| `src/reply.ts`         | Appending to the mention's reply file.                                               |
| `src/session-store.ts` | Remembers which session belongs to which conversation.                               |
