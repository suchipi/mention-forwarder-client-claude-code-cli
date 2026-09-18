# Running it as a macOS service

[`com.suchipi.mention-forwarder-client-claude-code-cli.plist`](./com.suchipi.mention-forwarder-client-claude-code-cli.plist) is a launchd job that keeps [`run.sh`](../run.sh) up: it starts at login, restarts within ten seconds if the process dies, and appends everything the whole stack prints to `.tmp/launchd.log` in this checkout. `run.sh` still does all the real work, so the config in `.run/` is the same config it reads when you start it by hand.

It is a LaunchAgent in `~/Library/LaunchAgents`, not a LaunchDaemon in `/Library/LaunchDaemons`, because `claude` runs as whoever it is logged in as and its credentials are in your login keychain. A daemon runs as root before anyone logs in and cannot read that keychain, so the agent would have no authentication. The cost of that choice is that the job starts at login rather than at boot; turn on automatic login if the machine has to come back up unattended.

## Installing it

1. Copy it into place: `cp launchd/com.suchipi.mention-forwarder-client-claude-code-cli.plist ~/Library/LaunchAgents/`
2. Replace every `/absolute/path/to/mention-forwarder-client-claude-code-cli` in the copy with this checkout, and `/absolute/path/to/the/node/bin` with the directory holding the `node` you want it to use — `dirname "$(which node)"`. launchd passes almost no environment to a job, so a `node` installed by a version manager is not on its `PATH` unless you name it here.
3. Check the result parses: `plutil -lint ~/Library/LaunchAgents/com.suchipi.mention-forwarder-client-claude-code-cli.plist`
4. Make the log's directory, which launchd will not create for you: `mkdir -p .tmp`
5. Load it: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.suchipi.mention-forwarder-client-claude-code-cli.plist`
6. If that reports `125: Domain does not support specified action`, your per-user agents live in the other domain; run the same command with `user/$(id -u)` in place of `gui/$(id -u)`, and use that domain everywhere below too.
7. Confirm it came up: `launchctl print gui/$(id -u)/com.suchipi.mention-forwarder-client-claude-code-cli | head -20` should say `state = running`.
8. Watch it start listening: `tail -f .tmp/launchd.log`

Nothing about the label is load-bearing. Rename it if you like, as long as the file's name and the `Label` inside it agree, and use the new name in the commands below.

## The commands you will want afterwards

- Restart: `launchctl kickstart -k gui/$(id -u)/com.suchipi.mention-forwarder-client-claude-code-cli`
- Status: `launchctl print gui/$(id -u)/com.suchipi.mention-forwarder-client-claude-code-cli`
- Logs: `tail -f .tmp/launchd.log`
- Stop it, until the next login: `launchctl bootout gui/$(id -u)/com.suchipi.mention-forwarder-client-claude-code-cli`
- Start it again: the `bootstrap` line from step 5.

`KeepAlive` is on, so the job comes back whenever it exits, cleanly or not. Stopping it means `bootout`; killing the process only buys you ten seconds. Stopping the job stops the forwarder, the client's web view, and the simulator together, because launchd signals the whole process group `run.sh` started.

After you edit the plist, `bootout` and `bootstrap` again — `kickstart` restarts the job as launchd already understands it and will not notice the file changed.

## Settings worth adding

Every environment variable [`run.sh`](../run.sh) reads can go in the plist's `EnvironmentVariables` beside `PATH`, which is how you point the job at a different checkout or turn things on without editing the script:

```xml
<key>AGENT_CWD</key>
<string>/absolute/path/to/the/checkout/the/agent/should/work/in</string>
```

If you upgrade `node` through a version manager, the `PATH` in the plist still names the old version's directory. Point it at the new one and reload the job.
