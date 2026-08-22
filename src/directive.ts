/** Reasoning effort levels `claude --effort` takes. */
export const EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

export type Directive = {
  model?: string;
  effort?: string;
};

export type Parsed = {
  /** What the group asked for, empty when the mention did not open with one. */
  directive: Directive;
  /** The mention with the group removed. */
  rest: string;
  /** Set when the group was addressed to this program but could not be honoured. */
  problem?: string;
};

const GROUP = /^\[([^\]\n]*)\]/;

/**
 * Reads a `[model=..., effort=...]` group off the front of a mention.
 *
 * Anything else in brackets is left alone and passed to the agent as written,
 * because a comment may well open with `[WIP]` or `[bug]` and mean nothing by it.
 * A group that names a setting this understands but gives it a value it does not
 * is reported instead, so a typo is never silently ignored.
 */
export function parseDirective(body: string): Parsed {
  const text = body.trim();
  const match = GROUP.exec(text);
  if (match === null) return { directive: {}, rest: text };

  const inside = match[1] ?? "";
  const parts = inside
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0) return { directive: {}, rest: text };

  const directive: Directive = {};
  for (const part of parts) {
    const split = part.indexOf("=");
    if (split < 0) return { directive: {}, rest: text };
    const name = part.slice(0, split).trim().toLowerCase();
    const value = part.slice(split + 1).trim();
    if (name === "model") directive.model = value;
    else if (name === "effort") directive.effort = value;
    else return { directive: {}, rest: text };
  }

  const rest = text.slice(match[0].length).trim();
  if (directive.model !== undefined && directive.model === "") {
    return { directive: {}, rest, problem: "that group set `model` to nothing. Write it as `[model=opus]`." };
  }
  if (directive.effort !== undefined && !EFFORT_LEVELS.includes(directive.effort.toLowerCase())) {
    return {
      directive: {},
      rest,
      problem: `I do not know the effort level \`${directive.effort}\`. It has to be one of ${EFFORT_LEVELS.join(", ")}.`,
    };
  }
  if (directive.effort !== undefined) directive.effort = directive.effort.toLowerCase();

  return { directive, rest };
}
