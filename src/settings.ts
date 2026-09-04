import type { Level } from "./logger.ts";

/** Reasoning effort levels `claude --effort` takes. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** What to do when Claude Code asks permission for a tool, or asks a question. */
export const APPROVAL_MODES = ["ask", "allow", "deny"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** Whether the thread sees the agent working, or only its answer. */
export const PROGRESS_MODES = ["all", "final"] as const;
export type Progress = (typeof PROGRESS_MODES)[number];

/** What `claude --permission-mode` takes. Checked here so a typo fails at startup, not mid-thread. */
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
] as const;

/** Typed as the logger's own levels, so the values offered and the values it takes cannot drift apart. */
export const LEVELS: readonly Level[] = ["debug", "info", "warn", "error"];

/**
 * The settings one thread may take on for itself, named and typed as the config
 * file names and types them, and holding only what a group in that thread has
 * actually set. Everything absent is whatever the process was started on.
 */
export type ThreadSettings = {
  binary?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  approval?: ApprovalMode;
  appendSystemPrompt?: string;
  allowedTools?: string;
  disallowedTools?: string;
  addDirs?: string[];
  claudeArgs?: string[];
  progress?: Progress;
  askTimeoutSeconds?: number;
};

export type ThreadSettingKey = keyof ThreadSettings;

/** In the order a thread is told about them, which is the order they are declared above. */
export const THREAD_SETTINGS: readonly ThreadSettingKey[] = [
  "binary",
  "model",
  "effort",
  "permissionMode",
  "approval",
  "appendSystemPrompt",
  "allowedTools",
  "disallowedTools",
  "addDirs",
  "claudeArgs",
  "progress",
  "askTimeoutSeconds",
];

/**
 * Whether changing a setting takes a new `claude`.
 *
 * Most of these are start-up flags, so the change lands on a restart and a group
 * carrying one needs a turn of its own. The two that are false are this
 * program's own doing rather than the CLI's, which is what lets `[progress=all]`
 * be written into a turn already running and take hold there.
 */
const RESTARTS: Record<ThreadSettingKey, boolean> = {
  binary: true,
  model: true,
  effort: true,
  permissionMode: true,
  // Not a flag, but the system prompt tells the agent whether anybody can answer it.
  approval: true,
  appendSystemPrompt: true,
  allowedTools: true,
  disallowedTools: true,
  addDirs: true,
  claudeArgs: true,
  progress: false,
  askTimeoutSeconds: false,
};

/**
 * The settings the whole process is on, and why one thread cannot take them on:
 * each is either shared with every other conversation this process is running,
 * or settled before any of them existed.
 */
const PROCESS_SETTINGS: Record<string, string> = {
  cwd: "Claude Code files a session under the directory it ran in, so a thread that moved would be starting over with nothing.",
  stateFile:
    "It is where this thread's own session and settings are kept, so moving it is how a thread loses both.",
  patternsFile:
    "How `claude`'s output is read is settled once, before any thread of this process starts.",
  recordFile:
    "It is one file of raw events for this process, not for one thread of it.",
  webPort:
    "One web view lists every conversation on this machine, so no one thread owns the port.",
  logLevel:
    "This process writes one log for every thread it is running at once.",
};

export const PROCESS_ONLY_SETTINGS: readonly string[] = Object.keys(PROCESS_SETTINGS);

/** Config-file spelling for a name written in a group, which is matched without regard to case. */
const CANONICAL: ReadonlyMap<string, string> = new Map(
  [...THREAD_SETTINGS, ...PROCESS_ONLY_SETTINGS].map((key) => [
    key.toLowerCase(),
    key,
  ]),
);

export function settingNamed(name: string): string | undefined {
  return CANONICAL.get(name.toLowerCase());
}

/** Why a setting the whole process is on cannot be changed from one thread of it. */
export function processSettingProblem(key: string): string {
  return `\`${key}\` is settled for this whole process, not for one thread of it. ${PROCESS_SETTINGS[key] ?? ""} Change it in the config file, or with its flag, and start the program again.`.trim();
}

export function hasSettings(settings: ThreadSettings): boolean {
  return entriesOf(settings).length > 0;
}

/** Whether taking these on needs a new `claude`, which is what makes them wait for a turn of their own. */
export function restartsClaude(settings: ThreadSettings): boolean {
  return entriesOf(settings).some(([key]) => RESTARTS[key]);
}

function oneOf(allowed: readonly string[]): string {
  return allowed.join(", ");
}

function positiveNumber(value: string): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Reads one `name=value` from a group into the settings being built, and says
 * what is wrong with it when something is. A value that names a setting this
 * understands is never quietly dropped: a typo in one is reported, so nobody is
 * left waiting on a setting that never took.
 *
 * A setting written more than once wins over its earlier self, except for the
 * list-valued ones, which collect: a group cannot hold a comma inside a value,
 * so repeating the name is how a list of more than one is written.
 */
export function readSetting(
  into: ThreadSettings,
  key: string,
  value: string,
): string | undefined {
  if (value === "") {
    return `that group set \`${key}\` to nothing. Write the value after the \`=\`, as in \`[${key}=...]\`.`;
  }

  switch (key) {
    case "binary":
      into.binary = value;
      return undefined;
    case "model":
      into.model = value;
      return undefined;
    case "effort": {
      const level = value.toLowerCase();
      if (!EFFORT_LEVELS.some((one) => one === level)) {
        return `I do not know the effort level \`${value}\`. It has to be one of ${oneOf(EFFORT_LEVELS)}.`;
      }
      into.effort = level;
      return undefined;
    }
    case "permissionMode": {
      // Matched as written, unlike the rest: these are the CLI's own spellings, and two of them are camelCase.
      if (!PERMISSION_MODES.some((one) => one === value)) {
        return `I do not know the permission mode \`${value}\`. It has to be one of ${oneOf(PERMISSION_MODES)}.`;
      }
      into.permissionMode = value;
      return undefined;
    }
    case "approval": {
      const mode = value.toLowerCase();
      if (mode !== "ask" && mode !== "allow" && mode !== "deny") {
        return `I do not know the approval mode \`${value}\`. It has to be one of ${oneOf(APPROVAL_MODES)}.`;
      }
      into.approval = mode;
      return undefined;
    }
    case "appendSystemPrompt":
      into.appendSystemPrompt = value;
      return undefined;
    case "allowedTools":
      into.allowedTools = value;
      return undefined;
    case "disallowedTools":
      into.disallowedTools = value;
      return undefined;
    case "addDirs":
      into.addDirs = [...(into.addDirs ?? []), value];
      return undefined;
    case "claudeArgs":
      into.claudeArgs = [...(into.claudeArgs ?? []), value];
      return undefined;
    case "progress": {
      const mode = value.toLowerCase();
      if (mode !== "all" && mode !== "final") {
        return `I do not know the progress mode \`${value}\`. It has to be one of ${oneOf(PROGRESS_MODES)}.`;
      }
      into.progress = mode;
      return undefined;
    }
    case "askTimeoutSeconds": {
      const seconds = positiveNumber(value);
      if (seconds === undefined) {
        return `\`askTimeoutSeconds\` has to be zero or a positive number of seconds, and \`${value}\` is neither.`;
      }
      into.askTimeoutSeconds = seconds;
      return undefined;
    }
    default:
      return processSettingProblem(key);
  }
}

/** How long a value is allowed to be where a setting is named back to the thread. */
const MAX_SHOWN_CHARS = 60;

function shown(value: string): string {
  const oneLine = value.replace(/\s*\n\s*/g, " ");
  const short =
    oneLine.length > MAX_SHOWN_CHARS
      ? `${oneLine.slice(0, MAX_SHOWN_CHARS)}...`
      : oneLine;
  return `\`${short}\``;
}

/** Each setting as one phrase, for telling a thread what it is now on. */
export function describeSettings(settings: ThreadSettings): string[] {
  return entriesOf(settings).map(
    ([key, values]) => `${key} ${values.map(shown).join(", ")}`,
  );
}

/**
 * The group that would set these again, which is what a mention carrying both a
 * setting and an instruction is rewritten as once the instruction has been split
 * off to run on its own.
 */
export function settingsToGroup(settings: ThreadSettings): string[] {
  return entriesOf(settings).flatMap(([key, values]) =>
    values.map((one) => `${key}=${one}`),
  );
}

/** Every setting that is actually set, in the order above, each as a list of its values. */
function entriesOf(settings: ThreadSettings): [ThreadSettingKey, string[]][] {
  const entries: [ThreadSettingKey, string[]][] = [];
  for (const key of THREAD_SETTINGS) {
    const value = settings[key];
    if (value === undefined) continue;
    entries.push([key, Array.isArray(value) ? value : [String(value)]]);
  }
  return entries;
}
