import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type ConfigFile, ConfigError, readConfigFile } from "./config-file.ts";
import type { Level } from "./logger.ts";
import {
  APPROVAL_MODES,
  EFFORT_LEVELS,
  LEVELS,
  PERMISSION_MODES,
  PROGRESS_MODES,
  type ApprovalMode,
  type Progress,
  type ThreadSettings,
} from "./settings.ts";

export type { ApprovalMode, Progress } from "./settings.ts";

export type Options = {
  binary: string;
  cwd: string;
  model: string | undefined;
  effort: string | undefined;
  permissionMode: string | undefined;
  approval: ApprovalMode;
  /** Operator instructions added to the end of the system prompt, or undefined for none. */
  appendSystemPrompt: string | undefined;
  allowedTools: string | undefined;
  disallowedTools: string | undefined;
  addDirs: string[];
  extraArgs: string[];
  progress: Progress;
  /** How long a parked ask waits for a person. `0` waits forever. */
  askTimeoutMs: number;
  /** Where conversation-to-session ids are remembered, or undefined to remember nothing. */
  stateFile: string | undefined;
  /**
   * Where a session records what it opened, so that the thread which comes of it
   * forks that session. Derived from the state file rather than set on its own,
   * because a fork resumes a session id kept there: no state, nothing to fork.
   */
  forkFile: string | undefined;
  /** Port the list of running conversations is served on, to local addresses only. `0` serves nothing. */
  webPort: number;
  patternsFile: string | undefined;
  recordPath: string | undefined;
  logLevel: Level;
};

/** Raw `parseArgs` output, before any of it is checked. */
export type Flags = {
  config?: string | undefined;
  binary?: string | undefined;
  cwd?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  "permission-mode"?: string | undefined;
  approval?: string | undefined;
  "append-system-prompt"?: string | undefined;
  "allowed-tools"?: string | undefined;
  "disallowed-tools"?: string | undefined;
  "add-dir"?: string[] | undefined;
  "claude-arg"?: string[] | undefined;
  progress?: string | undefined;
  "ask-timeout"?: string | undefined;
  "state-file"?: string | undefined;
  "no-state"?: boolean | undefined;
  "web-port"?: string | undefined;
  /** A mode rather than a setting, so nothing in `Options` comes of it; `cli.ts` reads it. */
  "web-only"?: boolean | undefined;
  patterns?: string | undefined;
  record?: string | undefined;
  "log-level"?: string | undefined;
};

/** Where the web view is served, unless `--web-port` says otherwise. */
export const DEFAULT_WEB_PORT = 4100;

function stateHome(): string {
  const base = process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
  return join(base, "mention-forwarder-claude-code");
}

export function defaultStateFile(): string {
  return join(stateHome(), "sessions.json");
}

/**
 * The fork file gets a directory of its own beside the state file, because that
 * directory is handed to the agent as one it may write in: the rest of the state,
 * other threads' session ids included, stays out of its way.
 */
export function forkFileFor(stateFile: string): string {
  return resolve(join(dirname(stateFile), "forks", "forks.jsonl"));
}

/**
 * Where each process publishes what it is doing, for the web view to list. Kept
 * apart from the state file so `--no-state` still shows up in the view.
 */
export function liveDirectory(): string {
  return join(stateHome(), "live");
}

function pick(name: string, chosen: string | undefined, allowed: readonly string[]): string {
  if (!allowed.includes(chosen ?? "")) {
    throw new ConfigError(`${name} must be one of ${allowed.join(", ")}, got "${chosen}"`);
  }
  return chosen as string;
}

function optional(name: string, chosen: string | undefined, allowed: readonly string[]): string | undefined {
  return chosen === undefined ? undefined : pick(name, chosen, allowed);
}

/** As `pick`, for the settings whose allowed values are also their type. */
function chosenFrom<T extends string>(name: string, chosen: string | undefined, allowed: readonly T[], fallback: T): T {
  if (chosen === undefined) return fallback;
  const found = allowed.find((one) => one === chosen);
  if (found === undefined) {
    throw new ConfigError(`${name} must be one of ${allowed.join(", ")}, got "${chosen}"`);
  }
  return found;
}

function chooseAskTimeout(flags: Flags, config: ConfigFile): number {
  const seconds = flags["ask-timeout"] === undefined ? config.askTimeoutSeconds : Number(flags["ask-timeout"]);
  if (seconds === undefined) return 0;
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new ConfigError(`--ask-timeout must be zero or a positive number of seconds, got "${flags["ask-timeout"] ?? config.askTimeoutSeconds}"`);
  }
  return Math.round(seconds * 1000);
}

function chooseWebPort(flags: Flags, config: ConfigFile): number {
  const port = flags["web-port"] === undefined ? config.webPort : Number(flags["web-port"]);
  if (port === undefined) return DEFAULT_WEB_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new ConfigError(`--web-port must be a port number, or 0 to serve nothing, got "${flags["web-port"] ?? config.webPort}"`);
  }
  return port;
}

/** Flags win over the config file, which wins over the built-in defaults. */
export function resolveOptions(flags: Flags): Options {
  const config = readConfigFile(flags.config);

  if (flags["no-state"] === true && flags["state-file"] !== undefined) {
    throw new ConfigError("--no-state and --state-file contradict each other; pass only one");
  }

  const effort = flags.effort ?? config.effort;
  const stateFile = flags["state-file"] ?? config.stateFile ?? defaultStateFile();
  const patternsFile = flags.patterns ?? config.patternsFile;
  const recordPath = flags.record ?? config.recordFile;

  return {
    binary: flags.binary ?? config.binary ?? "claude",
    cwd: resolve(flags.cwd ?? config.cwd ?? process.cwd()),
    model: flags.model ?? config.model,
    effort: optional("--effort", effort, EFFORT_LEVELS),
    permissionMode: optional("--permission-mode", flags["permission-mode"] ?? config.permissionMode, PERMISSION_MODES),
    approval: chosenFrom("--approval", flags.approval ?? config.approval, APPROVAL_MODES, "ask"),
    appendSystemPrompt: flags["append-system-prompt"] ?? config.appendSystemPrompt,
    allowedTools: flags["allowed-tools"] ?? config.allowedTools,
    disallowedTools: flags["disallowed-tools"] ?? config.disallowedTools,
    addDirs: (flags["add-dir"] ?? config.addDirs ?? []).map((one) => resolve(one)),
    extraArgs: flags["claude-arg"] ?? config.claudeArgs ?? [],
    progress: chosenFrom("--progress", flags.progress ?? config.progress, PROGRESS_MODES, "all"),
    askTimeoutMs: chooseAskTimeout(flags, config),
    stateFile: flags["no-state"] === true ? undefined : stateFile,
    forkFile: flags["no-state"] === true ? undefined : forkFileFor(stateFile),
    webPort: chooseWebPort(flags, config),
    patternsFile: patternsFile === undefined ? undefined : resolve(patternsFile),
    recordPath: recordPath === undefined ? undefined : resolve(recordPath),
    logLevel: chosenFrom("--log-level", flags["log-level"] ?? config.logLevel, LEVELS, "info"),
  };
}

/**
 * The options a thread is on, which are the ones this process was started on
 * with whatever a group in that thread has since changed laid over them.
 *
 * Only the settings a thread can own are here. The rest — where sessions are
 * remembered, which port the web view has, how `claude`'s output is read — are
 * shared with every other conversation this process is running, so a thread that
 * changed one would be changing them for threads that never asked.
 */
export function applyThreadSettings(base: Options, settings: ThreadSettings): Options {
  return {
    ...base,
    binary: settings.binary ?? base.binary,
    model: settings.model ?? base.model,
    effort: settings.effort ?? base.effort,
    permissionMode: settings.permissionMode ?? base.permissionMode,
    approval: settings.approval ?? base.approval,
    appendSystemPrompt: settings.appendSystemPrompt ?? base.appendSystemPrompt,
    allowedTools: settings.allowedTools ?? base.allowedTools,
    disallowedTools: settings.disallowedTools ?? base.disallowedTools,
    // Replaced rather than added to, so a thread can narrow what the process was
    // started with and not only widen it.
    addDirs: settings.addDirs ?? base.addDirs,
    extraArgs: settings.claudeArgs ?? base.extraArgs,
    progress: settings.progress ?? base.progress,
    askTimeoutMs: settings.askTimeoutSeconds === undefined ? base.askTimeoutMs : Math.round(settings.askTimeoutSeconds * 1000),
  };
}
