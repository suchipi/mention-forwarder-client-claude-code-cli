import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type ConfigFile, ConfigError, readConfigFile } from "./config-file.ts";
import { EFFORT_LEVELS } from "./directive.ts";
import type { Level } from "./logger.ts";

/** What to do when Claude Code asks permission for a tool, or asks a question. */
export type ApprovalMode = "ask" | "allow" | "deny";

/** Whether the thread sees the agent working, or only its answer. */
export type Progress = "all" | "final";

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
  patterns?: string | undefined;
  record?: string | undefined;
  "log-level"?: string | undefined;
};

export const APPROVAL_MODES: readonly string[] = ["ask", "allow", "deny"];
export const PROGRESS_MODES: readonly string[] = ["all", "final"];
export const LEVELS: readonly string[] = ["debug", "info", "warn", "error"];

/** What `claude --permission-mode` takes. Checked here so a typo fails at startup, not mid-thread. */
export const PERMISSION_MODES: readonly string[] = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];

export function defaultStateFile(): string {
  const base = process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
  return join(base, "mention-forwarder-claude-code", "sessions.json");
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

function chooseAskTimeout(flags: Flags, config: ConfigFile): number {
  const seconds = flags["ask-timeout"] === undefined ? config.askTimeoutSeconds : Number(flags["ask-timeout"]);
  if (seconds === undefined) return 0;
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new ConfigError(`--ask-timeout must be zero or a positive number of seconds, got "${flags["ask-timeout"] ?? config.askTimeoutSeconds}"`);
  }
  return Math.round(seconds * 1000);
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
    approval: pick("--approval", flags.approval ?? config.approval ?? "ask", APPROVAL_MODES) as ApprovalMode,
    appendSystemPrompt: flags["append-system-prompt"] ?? config.appendSystemPrompt,
    allowedTools: flags["allowed-tools"] ?? config.allowedTools,
    disallowedTools: flags["disallowed-tools"] ?? config.disallowedTools,
    addDirs: (flags["add-dir"] ?? config.addDirs ?? []).map((one) => resolve(one)),
    extraArgs: flags["claude-arg"] ?? config.claudeArgs ?? [],
    progress: pick("--progress", flags.progress ?? config.progress ?? "all", PROGRESS_MODES) as Progress,
    askTimeoutMs: chooseAskTimeout(flags, config),
    stateFile: flags["no-state"] === true ? undefined : stateFile,
    patternsFile: patternsFile === undefined ? undefined : resolve(patternsFile),
    recordPath: recordPath === undefined ? undefined : resolve(recordPath),
    logLevel: pick("--log-level", flags["log-level"] ?? config.logLevel ?? "info", LEVELS) as Level,
  };
}
