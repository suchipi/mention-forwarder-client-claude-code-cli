#!/usr/bin/env bash
# Runs mention-forwarder with this client as its command, as ordinary processes
# on this machine. Set SIM_PLATFORM to bring up the forwarder's simulator too,
# which is a whole round trip without a real account, a tunnel, or a webhook.
#
# Usage: run.sh [client-flag ...]
#
# Anything on the command line is passed to this client, e.g.
#
#   ./run.sh --no-state --log-level debug
#
# Environment:
#   MENTION_FORWARDER_DIR  where mention-forwarder is checked out (default: ../mention-forwarder)
#   CONFIG_DIR             where the generated config lives (default: ./.run)
#   AGENT_CWD              the checkout the agent works in (default: $CONFIG_DIR/workspace)
#   TRIGGER                the phrase that counts as a mention (default: @my-bot)
#   SIM_PLATFORM           github, slack, or linear: also run the simulator, against that one
#   SIM_PORT               the simulator's port (default: 4000)
#   WEB_PORT               the client's web view, on 127.0.0.1 (default: 4100; 0 for none).
#                          Read when the config is first written.
set -euo pipefail

repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
forwarder_dir="${MENTION_FORWARDER_DIR:-$(cd -- "$repo/.." && pwd)/mention-forwarder}"
config_dir="${CONFIG_DIR:-$repo/.run}"
agent_cwd="${AGENT_CWD:-$config_dir/workspace}"
trigger="${TRIGGER:-@my-bot}"
sim_port="${SIM_PORT:-4000}"
web_port="${WEB_PORT:-4100}"

forwarder_config="$config_dir/mention-forwarder.config.json"
client_config="$config_dir/mention-forwarder-claude-code.config.json"
forwarder_env="$config_dir/mention-forwarder.env"

say() { printf '[run] %s\n' "$*"; }
# BSD sed has no -u, so awk does the line-buffered prefixing instead.
prefix() { awk -v tag="$1" '{ print "[" tag "] " $0; fflush() }'; }

if [[ ! -d $forwarder_dir ]]; then
  say "no mention-forwarder at $forwarder_dir. Clone it beside this one, or set MENTION_FORWARDER_DIR." >&2
  exit 1
fi
if [[ ! -d $forwarder_dir/node_modules ]]; then
  say "installing mention-forwarder's dependencies"
  npm install --prefix "$forwarder_dir"
fi

mkdir -p "$config_dir" "$agent_cwd"

# Seeded once and then left alone, so edits survive the next run. Delete a file
# to have it written again.
if [[ ! -f $forwarder_config ]]; then
  node -e '
    const [repo, cwd, clientConfig, trigger] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      command: ["node", `${repo}/src/cli.ts`, "--config", clientConfig],
      cwd,
      lifecycle: "per-conversation",
      port: 3000,
      timeoutMs: 0,
      sessionIdleMs: 900000,
      replyDebounceMs: 1500,
      maxConcurrentConversations: 4,
      ignoreBots: true,
      logLevel: "info",
      github: { triggerPhrases: [trigger] },
      linear: { triggerPhrases: [trigger] },
      slack: {},
    }, null, 2) + "\n");
  ' "$repo" "$agent_cwd" "$client_config" "$trigger" > "$forwarder_config"
  say "wrote $forwarder_config"
fi
# Written rather than copied from the example, which spells out every setting and
# so names files that would not exist beside the copy.
if [[ ! -f $client_config ]]; then
  cat > "$client_config" <<JSON
{
  "\$schema": "$repo/mention-forwarder-claude-code.config.schema.json",
  "model": "opus",
  "effort": "high",
  "approval": "ask",
  "permissionMode": "acceptEdits",
  "progress": "all",
  "askTimeoutSeconds": 0,
  "webPort": $web_port,
  "logLevel": "info"
}
JSON
  say "wrote $client_config"
fi
if [[ ! -f $forwarder_env ]]; then
  # The simulator signs its own webhooks and answers its own API, so its secrets
  # are fake on purpose and nothing has to be filled in to use it.
  if [[ -n ${SIM_PLATFORM:-} ]]; then
    cp "$forwarder_dir/simulator/forwarder.env" "$forwarder_env"
  else
    cp "$forwarder_dir/.env.example" "$forwarder_env"
  fi
  say "wrote $forwarder_env"
fi

# Read, deliberately without exporting: what a child process sees has to be
# decided by the env file passed to it, not by whatever leaked out of here.
# shellcheck disable=SC1090
source "$forwarder_env"

effective_config="$forwarder_config"
effective_env="$forwarder_env"

# The client is started by mention-forwarder rather than from here, so a flag for
# it has to reach the command in the config. Written aside so the file you edit is
# never rewritten, and derived fresh each run so yesterday's flags do not linger.
if [[ $# -gt 0 ]]; then
  args_config="$config_dir/mention-forwarder.args.config.json"
  node -e '
    const fs = require("node:fs");
    const [source, destination, ...extra] = process.argv.slice(1);
    const config = JSON.parse(fs.readFileSync(source, "utf8"));
    config.command = [...config.command, ...extra];
    fs.writeFileSync(destination, JSON.stringify(config, null, 2) + "\n");
  ' "$effective_config" "$args_config" "$@"
  effective_config="$args_config"
  say "passing to the client: $*"
fi

if [[ -n ${SIM_PLATFORM:-} ]]; then
  case "$SIM_PLATFORM" in
    github) api_url="http://127.0.0.1:$sim_port/api/github" ;;
    slack) api_url="http://127.0.0.1:$sim_port/api/slack/" ;;
    linear) api_url="http://127.0.0.1:$sim_port/api/linear/graphql" ;;
    *) say "unknown SIM_PLATFORM=$SIM_PLATFORM; choose github, slack, or linear" >&2; exit 1 ;;
  esac

  # Replies and reactions have to come back to the simulator rather than to the
  # real platform. Written aside so the file you edit is never rewritten, and
  # derived from whatever the step above settled on so both can apply at once.
  simulator_source="$effective_config"
  effective_config="$config_dir/mention-forwarder.simulator.config.json"
  node -e '
    const fs = require("node:fs");
    const [source, destination, platform, url] = process.argv.slice(1);
    const config = JSON.parse(fs.readFileSync(source, "utf8"));
    config[platform] = { ...config[platform], apiUrl: url };
    fs.writeFileSync(destination, JSON.stringify(config, null, 2) + "\n");
  ' "$simulator_source" "$effective_config" "$SIM_PLATFORM" "$api_url"

  # A platform is on only when its secret is present, and one simulator imitates
  # one platform, so the other two are left off rather than warning about
  # credentials for webhooks that can never arrive. A placeholder is enough:
  # the simulator signs its own webhooks with whatever value it finds.
  effective_env="$config_dir/mention-forwarder.simulator.env"
  case "$SIM_PLATFORM" in
    github) printf 'GITHUB_WEBHOOK_SECRET=%s\nGITHUB_TOKEN=%s\n' \
      "${GITHUB_WEBHOOK_SECRET:-simulator}" "${GITHUB_TOKEN:-ghp_simulator}" > "$effective_env" ;;
    slack) printf 'SLACK_SIGNING_SECRET=%s\nSLACK_BOT_TOKEN=%s\n' \
      "${SLACK_SIGNING_SECRET:-simulator}" "${SLACK_BOT_TOKEN:-xoxb-simulator}" > "$effective_env" ;;
    linear) printf 'LINEAR_WEBHOOK_SECRET=%s\nLINEAR_API_KEY=%s\n' \
      "${LINEAR_WEBHOOK_SECRET:-simulator}" "${LINEAR_API_KEY:-lin_api_simulator}" > "$effective_env" ;;
  esac
elif [[ -z ${GITHUB_WEBHOOK_SECRET:-}${SLACK_SIGNING_SECRET:-}${LINEAR_WEBHOOK_SECRET:-} ]]; then
  cat >&2 <<MESSAGE
[run] No platform is enabled, so there is nothing to listen for.

  Put a webhook secret in $forwarder_env,
  or run the simulator instead, which needs no account at all:

    SIM_PLATFORM=github $0
MESSAGE
  exit 1
fi

webhook_port="$(node -e '
  process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).port ?? 3000));
' "$effective_config")"

# Read back rather than trusted: WEB_PORT only seeds a config that was not there
# yet, so the file is what the client will actually serve on.
web_port="$(node -e '
  process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).webPort ?? 4100));
' "$client_config")"

if [[ $web_port != 0 && $web_port == "$webhook_port" ]]; then
  say "the web view's port $web_port is the forwarder's own; change webPort in $client_config" >&2
  exit 1
fi

sim_pid=""
view_pid=""
cleanup() {
  if [[ -n $sim_pid ]]; then kill "$sim_pid" 2>/dev/null || true; fi
  if [[ -n $view_pid ]]; then kill "$view_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

# A conversation's process exists only between its first mention and
# sessionIdleMs after its last, so a view served by one of those is only up while
# there is a thread to serve it. This one is up the whole time; a conversation
# that finds the port taken carries on without a view of its own.
if [[ $web_port != 0 ]]; then
  node "$repo/src/cli.ts" --config "$client_config" "$@" --web-only \
    > >(prefix conversations) 2>&1 &
  view_pid=$!
fi

if [[ -n ${SIM_PLATFORM:-} ]]; then
  if [[ $sim_port == "$webhook_port" ]]; then
    say "SIM_PORT $sim_port is the forwarder's own port; pick another" >&2
    exit 1
  fi
  if [[ $sim_port == "$web_port" ]]; then
    say "SIM_PORT $sim_port is the client's web view port; pick another" >&2
    exit 1
  fi
  node "$forwarder_dir/simulator/cli.ts" \
    --platform "$SIM_PLATFORM" --port "$sim_port" \
    --config "$effective_config" --env-file "$effective_env" \
    > >(prefix simulator) 2>&1 &
  sim_pid=$!
fi

cat <<MESSAGE

  agent works in  $agent_cwd
  client config   $client_config
  webhooks        http://localhost:$webhook_port
$(if [[ $web_port != 0 ]]; then printf '  conversations   http://127.0.0.1:%s (what every thread is doing right now)\n' "$web_port"; fi)
$(if [[ -n ${SIM_PLATFORM:-} ]]; then printf '  simulator       http://127.0.0.1:%s (post "%s do something" in a thread)\n' "$sim_port" "$trigger"; fi)
MESSAGE

node "$forwarder_dir/src/cli.ts" --config "$effective_config" --env-file "$effective_env" 2>&1 | prefix forwarder
