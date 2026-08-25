import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Anything wrong with how this program was configured, from a flag or from the file. */
export class ConfigError extends Error {}

/** Looked for in the working directory mention-forwarder starts the command in. */
export const DEFAULT_CONFIG_FILE = "mention-forwarder-claude-code.config.json";

export type ConfigFile = {
  binary?: string;
  /** Path, resolved against the config file's own directory. */
  cwd?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  approval?: string;
  /** Added to the end of the system prompt this program builds. */
  appendSystemPrompt?: string;
  allowedTools?: string;
  disallowedTools?: string;
  /** Paths, resolved against the config file's own directory. */
  addDirs?: string[];
  /** Passed to `claude` untouched, after everything this program sets. */
  claudeArgs?: string[];
  progress?: string;
  askTimeoutSeconds?: number;
  /** Path, resolved against the config file's own directory. */
  stateFile?: string;
  /** Path, resolved against the config file's own directory. */
  patternsFile?: string;
  /** Path, resolved against the config file's own directory. */
  recordFile?: string;
  logLevel?: string;
};

const STRING_FIELDS = [
  "binary",
  "cwd",
  "model",
  "effort",
  "permissionMode",
  "approval",
  "appendSystemPrompt",
  "allowedTools",
  "disallowedTools",
  "progress",
  "stateFile",
  "patternsFile",
  "recordFile",
  "logLevel",
] as const;
const STRING_LIST_FIELDS = ["addDirs", "claudeArgs"] as const;
const NUMBER_FIELDS = ["askTimeoutSeconds"] as const;
/** Every setting the file may hold. `mention-forwarder-claude-code.config.schema.json` is checked against it. */
export const KNOWN_FIELDS: readonly string[] = [...STRING_FIELDS, ...STRING_LIST_FIELDS, ...NUMBER_FIELDS];

/** Editors read `$schema` to offer hovers and completion in the config file; this program never does. */
const IGNORED_FIELDS: readonly string[] = ["$schema"];
const PATH_FIELDS: readonly string[] = ["cwd", "stateFile", "patternsFile", "recordFile"];
const PATH_LIST_FIELDS: readonly string[] = ["addDirs"];

/**
 * Reads the config file, if there is one.
 *
 * `path` given explicitly must exist; the default one is optional, so the
 * program runs on flags alone. Paths inside are resolved against the file's own
 * directory, since the working directory is whatever mention-forwarder was
 * started in.
 */
export function readConfigFile(path: string | undefined): ConfigFile {
  const file = path ?? DEFAULT_CONFIG_FILE;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && path === undefined) return {};
    throw new ConfigError(`could not read the config file ${file}: ${(error as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`${file} must hold a JSON object`);
  }

  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_FIELDS.includes(key) && !IGNORED_FIELDS.includes(key)) {
      throw new ConfigError(`${file} has an unknown setting "${key}". It takes: ${KNOWN_FIELDS.join(", ")}.`);
    }
  }

  const config: ConfigFile = {};
  const directory = dirname(resolve(file));

  for (const key of STRING_FIELDS) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new ConfigError(`"${key}" in ${file} must be a string`);
    config[key] = PATH_FIELDS.includes(key) ? resolve(directory, value) : value;
  }

  for (const key of STRING_LIST_FIELDS) {
    const value = record[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((one) => typeof one !== "string")) {
      throw new ConfigError(`"${key}" in ${file} must be a list of strings`);
    }
    const items = value as string[];
    config[key] = PATH_LIST_FIELDS.includes(key) ? items.map((one) => resolve(directory, one)) : items;
  }

  for (const key of NUMBER_FIELDS) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "number") throw new ConfigError(`"${key}" in ${file} must be a number`);
    config[key] = value;
  }

  return config;
}
