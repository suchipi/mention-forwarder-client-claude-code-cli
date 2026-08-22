export type Level = "debug" | "info" | "warn" | "error";

export type Logger = {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const MAX_FIELD_CHARS = 400;

function formatValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "undefined";
  const oneLine = text.replace(/\s*\n\s*/g, " ");
  return oneLine.length > MAX_FIELD_CHARS ? `${oneLine.slice(0, MAX_FIELD_CHARS)}...` : oneLine;
}

function formatFields(fields: Record<string, unknown>): string {
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${formatValue(value)}`);
  return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
}

/** No timestamps: mention-forwarder stamps and prefixes every line it reads from us. */
export function createLogger(minLevel: Level): Logger {
  const emit = (level: Level, message: string, fields?: Record<string, unknown>) => {
    if (RANK[level] < RANK[minLevel]) return;
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(`${level.toUpperCase().padEnd(5)} ${message}${fields ? formatFields(fields) : ""}\n`);
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}
