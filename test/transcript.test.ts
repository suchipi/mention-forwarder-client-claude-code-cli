import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { findTranscript, type Moment, readTranscript } from "../src/transcript.ts";

const directories: string[] = [];

after(() => {
  for (const path of directories) rmSync(path, { recursive: true, force: true });
});

const SESSION = "11111111-2222-3333-4444-555555555555";

/** A projects directory holding one session's transcript, as Claude Code lays them out. */
function transcript(lines: unknown[], sessionId = SESSION): { projects: string; file: string } {
  const projects = mkdtempSync(join(tmpdir(), "mfcc-projects-"));
  directories.push(projects);
  mkdirSync(join(projects, "-tmp-somewhere-else"), { recursive: true });
  const project = join(projects, "-tmp-checkout");
  mkdirSync(project, { recursive: true });
  const file = join(project, `${sessionId}.jsonl`);
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + (lines.length === 0 ? "" : "\n"));
  return { projects, file };
}

function assistant(content: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { type: "assistant", timestamp: "2026-08-22T00:00:01.000Z", message: { role: "assistant", content }, ...extra };
}

function user(content: unknown, extra: Record<string, unknown> = {}): unknown {
  return { type: "user", timestamp: "2026-08-22T00:00:00.000Z", message: { role: "user", content }, ...extra };
}

function momentsOf(lines: unknown[]): Moment[] {
  const { file } = transcript(lines);
  return readTranscript(file, 0).moments;
}

describe("finding a session's transcript", () => {
  it("looks under every project, since which one holds it is not ours to work out", () => {
    const { projects, file } = transcript([]);
    strictEqual(findTranscript(SESSION, projects), file);
  });

  it("finds nothing for a session nothing has written", () => {
    const { projects } = transcript([]);
    strictEqual(findTranscript("99999999-2222-3333-4444-555555555555", projects), undefined);
  });

  it("refuses an id that is not one, rather than joining it to a path", () => {
    const { projects } = transcript([]);
    for (const id of ["", "..", "../../etc/passwd", `../-tmp-checkout/${SESSION}`, "not a session"]) {
      strictEqual(findTranscript(id, projects), undefined, `${id} was looked up`);
    }
  });

  it("finds nothing when there are no projects at all", () => {
    strictEqual(findTranscript(SESSION, join(tmpdir(), "mfcc-no-such-projects")), undefined);
  });
});

describe("reading a session's transcript", () => {
  it("keeps what a person said, what the agent said, and what it ran", () => {
    const moments = momentsOf([
      user([{ type: "text", text: "please fix the flaky test" }]),
      assistant([{ type: "text", text: "Having a look." }]),
      assistant([{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } }]),
      user([{ type: "tool_result", tool_use_id: "toolu_1", content: "3 passing" }]),
    ]);

    deepStrictEqual(
      moments.map((one) => [one.from, one.tool ?? "", one.text]),
      [
        ["person", "", "please fix the flaky test"],
        ["agent", "", "Having a look."],
        ["tool", "Bash", '{\n  "command": "npm test"\n}'],
        ["result", "", "3 passing"],
      ],
    );
  });

  it("ties a result to the call it answers, which is all that does when calls run at once", () => {
    const moments = momentsOf([
      assistant([
        { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
        { type: "tool_use", id: "toolu_2", name: "Grep", input: {} },
      ]),
      user([
        { type: "tool_result", tool_use_id: "toolu_2", content: "no matches" },
        { type: "tool_result", tool_use_id: "toolu_1", content: "a file" },
      ]),
    ]);

    deepStrictEqual(
      moments.map((one) => one.useId),
      ["toolu_1", "toolu_2", "toolu_2", "toolu_1"],
    );
  });

  it("says which results the tool called failures", () => {
    const [failed, fine] = momentsOf([
      user([
        { type: "tool_result", tool_use_id: "toolu_1", content: "no such file", is_error: true },
        { type: "tool_result", tool_use_id: "toolu_2", content: "fine" },
      ]),
    ]);

    strictEqual(failed?.failed, true);
    strictEqual(fine?.failed, undefined);
  });

  it("flattens a result that came back as blocks rather than as text", () => {
    const [result] = momentsOf([
      user([
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [{ type: "text", text: "a screenshot of" }, { type: "image" }],
        },
      ]),
    ]);

    strictEqual(result?.text, "a screenshot of\n[image]");
  });

  it("marks what a subagent did, which happens off to the side of the thread", () => {
    const [aside] = momentsOf([assistant([{ type: "text", text: "found it" }], { isSidechain: true })]);
    strictEqual(aside?.aside, true);
  });

  it("keeps an api error, which is most of why a quiet turn is quiet", () => {
    const [note] = momentsOf([
      {
        type: "system",
        subtype: "api_error",
        timestamp: "2026-08-22T00:00:02.000Z",
        error: { message: "Connection error.", formatted: "Connection dropped (ECONNRESET)" },
      },
    ]);

    strictEqual(note?.from, "note");
    strictEqual(note?.text, "Connection dropped (ECONNRESET)");
  });

  it("leaves out the CLI's own bookkeeping and the preamble it writes itself", () => {
    deepStrictEqual(
      momentsOf([
        { type: "mode", mode: "normal" },
        { type: "atis-latch", atis: "" },
        { type: "last-prompt", lastPrompt: "something" },
        { type: "attachment", attachment: { type: "hook_success", content: "ran a hook" } },
        user("Caveat: the messages below were generated by the user", { isMeta: true }),
        // Empty on a model that keeps its reasoning to itself, which is all of them so far.
        assistant([{ type: "thinking", thinking: "", signature: "abc" }]),
      ]),
      [],
    );
  });

  it("keeps reasoning when a model does write it down", () => {
    const [thought] = momentsOf([assistant([{ type: "thinking", thinking: "the test is time-dependent" }])]);
    strictEqual(thought?.from, "thought");
    strictEqual(thought?.text, "the test is time-dependent");
  });

  it("says how much of a long block it did not keep", () => {
    const [result] = momentsOf([user([{ type: "tool_result", tool_use_id: "t", content: "x".repeat(20500) }])]);
    strictEqual(result?.text.length, 20000);
    strictEqual(result?.cut, 500);
  });

  it("carries on past a line it cannot read", () => {
    const { projects, file } = transcript([assistant([{ type: "text", text: "first" }])]);
    appendFileSync(file, "{ this is not json\n");
    appendFileSync(file, `${JSON.stringify(assistant([{ type: "text", text: "second" }]))}\n`);
    ok(projects.length > 0);

    deepStrictEqual(
      readTranscript(file, 0).moments.map((one) => one.text),
      ["first", "second"],
    );
  });

  it("leaves a half-written last line for the next read", () => {
    const { file } = transcript([assistant([{ type: "text", text: "first" }])]);
    const whole = readTranscript(file, 0);
    appendFileSync(file, `${JSON.stringify(assistant([{ type: "text", text: "second" }])).slice(0, 40)}`);

    const partial = readTranscript(file, whole.next);
    deepStrictEqual(partial.moments, []);
    strictEqual(partial.next, whole.next);
  });

  it("reads only what has been added since the last read", () => {
    const { file } = transcript([assistant([{ type: "text", text: "first" }])]);
    const first = readTranscript(file, 0);
    appendFileSync(file, `${JSON.stringify(assistant([{ type: "text", text: "second" }]))}\n`);

    const second = readTranscript(file, first.next);
    deepStrictEqual(
      second.moments.map((one) => one.text),
      ["second"],
    );
    strictEqual(second.from, first.next);
    strictEqual(second.next, second.size);
  });

  it("starts over when the file is shorter than where it left off, since it was replaced", () => {
    const { file } = transcript([assistant([{ type: "text", text: "first" }])]);
    const page = readTranscript(file, 10000);

    strictEqual(page.from, 0);
    deepStrictEqual(
      page.moments.map((one) => one.text),
      ["first"],
    );
  });
});
