// An example --patterns file.
//
// It is handed the built-in rules and returns the ones to use, so a claude
// release that moves a field can be absorbed here rather than in src/patterns.ts.
// Rules are tried in order and the first one that returns a non-null array wins,
// so anything put in front of a built-in rule replaces it.

export default function patch(rules) {
  return [
    // 1. Claim an event type a later claude added, so it stops being reported as
    //    unrecognized. Return [] to say "this means nothing".
    {
      name: "example/ignore-something-new",
      shape: `{"type":"a_new_event_type"}`,
      match: (event) => (event.type === "a_new_event_type" ? [] : null),
    },

    // 2. Replace a built-in rule by name, leaving the rest of the order alone.
    //    This one pretends a future release renamed `result` to `turn_result`.
    ...rules.map((rule) =>
      rule.name === "result"
        ? {
            ...rule,
            match: (event) => rule.match(event.type === "turn_result" ? { ...event, type: "result" } : event),
          }
        : rule,
    ),
  ];
}
