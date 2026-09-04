import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { CLEAR_WORDS, COMPACT_WORDS, EXIT_WORDS, FORK_WORDS, INTERRUPT_WORDS, parseDirective } from "../src/directive.ts";
import { APPROVALS, isApproval } from "../src/answer.ts";
import { readSetting, THREAD_SETTINGS } from "../src/settings.ts";

/** One value per setting a thread may take on, so nothing it offers can turn out to be unreadable. */
const A_VALUE: Record<string, string> = {
  binary: "/usr/local/bin/claude",
  model: "opus",
  effort: "max",
  permissionMode: "acceptEdits",
  approval: "ask",
  appendSystemPrompt: "be brief",
  allowedTools: "Read Grep",
  disallowedTools: "WebFetch",
  addDirs: "/tmp/shared",
  claudeArgs: "--verbose",
  progress: "all",
  askTimeoutSeconds: "60",
};

describe("the [setting=...] group", () => {
  it("reads both settings and hands back the rest", () => {
    const parsed = parseDirective("[model=opus, effort=high] work out why the deploy hangs");
    deepStrictEqual(parsed.directive, { settings: { model: "opus", effort: "high" } });
    strictEqual(parsed.rest, "work out why the deploy hangs");
  });

  it("takes either setting alone, in either order", () => {
    deepStrictEqual(parseDirective("[effort=max] go").directive, { settings: { effort: "max" } });
    deepStrictEqual(parseDirective("[effort=low, model=haiku] go").directive, { settings: { model: "haiku", effort: "low" } });
  });

  it("does not care about the case of a setting name or an effort level", () => {
    deepStrictEqual(parseDirective("[MODEL=opus, Effort=HIGH] go").directive, { settings: { model: "opus", effort: "high" } });
  });

  it("leaves a group with nothing after it, so it can be answered on its own", () => {
    const parsed = parseDirective("[model=sonnet]");
    deepStrictEqual(parsed.directive, { settings: { model: "sonnet" } });
    strictEqual(parsed.rest, "");
  });

  it("leaves ordinary brackets alone", () => {
    for (const body of ["[WIP] fix the test", "[bug] it crashes", "[see #12] look here", "just some text"]) {
      deepStrictEqual(parseDirective(body).directive, { settings: {} }, body);
      strictEqual(parseDirective(body).rest, body);
    }
  });

  it("reports an effort level it does not know instead of ignoring it", () => {
    const parsed = parseDirective("[effort=turbo] go");
    deepStrictEqual(parsed.directive, { settings: {} });
    match(parsed.problem ?? "", /effort level `turbo`/);
  });

  it("reports a model set to nothing", () => {
    match(parseDirective("[model=] go").problem ?? "", /set `model` to nothing/);
  });

  it("takes any setting the config file takes, not only the model and the effort", () => {
    deepStrictEqual(parseDirective("[progress=all] go").directive, { settings: { progress: "all" } });
    deepStrictEqual(parseDirective("[approval=deny] go").directive, { settings: { approval: "deny" } });
    deepStrictEqual(parseDirective("[askTimeoutSeconds=90] go").directive, { settings: { askTimeoutSeconds: 90 } });
    deepStrictEqual(parseDirective("[permissionMode=acceptEdits] go").directive, {
      settings: { permissionMode: "acceptEdits" },
    });
    deepStrictEqual(parseDirective("[allowedTools=Read Grep] go").directive, {
      settings: { allowedTools: "Read Grep" },
    });
  });

  it("does not care about the case of a setting name, however it is spelled in the file", () => {
    deepStrictEqual(parseDirective("[PROGRESS=Final] go").directive, { settings: { progress: "final" } });
    deepStrictEqual(parseDirective("[appendsystemprompt=be brief] go").directive, {
      settings: { appendSystemPrompt: "be brief" },
    });
  });

  it("keeps a permission mode as written, since two of them are camelCase", () => {
    match(parseDirective("[permissionMode=acceptedits] go").problem ?? "", /permission mode `acceptedits`/);
  });

  it("collects a list-valued setting from the name written more than once", () => {
    deepStrictEqual(parseDirective("[addDirs=/a, addDirs=/b] go").directive, {
      settings: { addDirs: ["/a", "/b"] },
    });
    deepStrictEqual(parseDirective("[claudeArgs=--mcp-config, claudeArgs=./mcp.json] go").directive, {
      settings: { claudeArgs: ["--mcp-config", "./mcp.json"] },
    });
  });

  it("reports a value a setting does not take, whichever setting it is", () => {
    match(parseDirective("[progress=some] go").problem ?? "", /progress mode `some`/);
    match(parseDirective("[approval=maybe] go").problem ?? "", /approval mode `maybe`/);
    match(parseDirective("[askTimeoutSeconds=soon] go").problem ?? "", /askTimeoutSeconds/);
    match(parseDirective("[askTimeoutSeconds=-1] go").problem ?? "", /askTimeoutSeconds/);
  });

  it("refuses a setting the whole process is on rather than pretending to change it", () => {
    for (const body of ["[logLevel=debug] go", "[webPort=4200] go", "[cwd=/tmp] go", "[stateFile=./s.json] go"]) {
      const parsed = parseDirective(body);
      deepStrictEqual(parsed.directive, { settings: {} }, body);
      match(parsed.problem ?? "", /settled for this whole process/, body);
    }
  });

  it("hands the rest back with a problem, so what was asked for is not lost with the group", () => {
    strictEqual(parseDirective("[progress=some] look at the tests").rest, "look at the tests");
  });

  it("can read every setting it offers, so none of them is named and then refused", () => {
    for (const key of THREAD_SETTINGS) {
      const value = A_VALUE[key];
      ok(value !== undefined, `this test has no value to try for \`${key}\``);
      strictEqual(readSetting({}, key, value), undefined, key);
    }
  });

  it("leaves a name that is not a setting alone, because those brackets are somebody else's", () => {
    for (const body of ["[fixes=#12] have a look", "[owner=you] go"]) {
      deepStrictEqual(parseDirective(body).directive, { settings: {} }, body);
      strictEqual(parseDirective(body).rest, body);
      strictEqual(parseDirective(body).problem, undefined, body);
    }
  });
});

describe("the [interrupt] word", () => {
  it("takes any of the words it documents, whatever their case", () => {
    for (const word of ["interrupt", "stop", "int", "STOP", "Interrupt"]) {
      deepStrictEqual(parseDirective(`[${word}]`).directive, { settings: {}, interrupt: true }, word);
    }
  });

  it("hands back whatever followed it, so it can stop one thing and start another", () => {
    const parsed = parseDirective("[stop] look at the other branch instead");
    deepStrictEqual(parsed.directive, { settings: {}, interrupt: true });
    strictEqual(parsed.rest, "look at the other branch instead");
  });

  it("sits alongside the settings, in either order", () => {
    deepStrictEqual(parseDirective("[interrupt, model=opus] retry").directive, { settings: { model: "opus" }, interrupt: true });
    deepStrictEqual(parseDirective("[effort=max, stop] retry").directive, { settings: { effort: "max" }, interrupt: true });
  });

  it("leaves a bare word it does not know alone, group and all", () => {
    for (const body of ["[halt] go", "[stopping] go", "[stop it] go"]) {
      deepStrictEqual(parseDirective(body).directive, { settings: {} }, body);
      strictEqual(parseDirective(body).rest, body);
    }
  });

  it("says the same thing in the README as it does here", () => {
    // People stop a turn by copying a word out of that list, so a word only one
    // of the two knows about is a bug either way round.
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");
    const block = /## Stopping a turn[\s\S]*?```\n([\s\S]*?)```/.exec(readme)?.[1];
    if (block === undefined) throw new Error("the README no longer lists the interrupt words under '## Stopping a turn'");

    const documented = block
      .split(/\n|\s{2,}/)
      .map((word) => word.trim())
      .filter((word) => word !== "");
    deepStrictEqual(new Set(documented), INTERRUPT_WORDS);
  });
});

describe("the [exit] word", () => {
  it("takes any of the words it documents, whatever their case", () => {
    for (const word of ["exit", "quit", "EXIT", "Quit"]) {
      deepStrictEqual(parseDirective(`[${word}]`).directive, { settings: {}, exit: true }, word);
    }
  });

  it("hands back whatever followed it, so it can end one process and set the next to work", () => {
    const parsed = parseDirective("[exit] have another go at it");
    deepStrictEqual(parsed.directive, { settings: {}, exit: true });
    strictEqual(parsed.rest, "have another go at it");
  });

  it("sits alongside the settings and the interrupt word", () => {
    deepStrictEqual(parseDirective("[exit, model=opus] retry").directive, { settings: { model: "opus" }, exit: true });
    deepStrictEqual(parseDirective("[stop, quit] retry").directive, { settings: {}, interrupt: true, exit: true });
  });

  it("leaves a bare word it does not know alone, group and all", () => {
    for (const body of ["[exited] go", "[quitting] go", "[exit now] go"]) {
      deepStrictEqual(parseDirective(body).directive, { settings: {} }, body);
      strictEqual(parseDirective(body).rest, body);
    }
  });

  it("says the same thing in the README as it does here", () => {
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");
    const block = /## Ending the process[\s\S]*?```\n([\s\S]*?)```/.exec(readme)?.[1];
    if (block === undefined) throw new Error("the README no longer lists the exit words under '## Ending the process'");

    const documented = block
      .split(/\n|\s{2,}/)
      .map((word) => word.trim())
      .filter((word) => word !== "");
    deepStrictEqual(new Set(documented), EXIT_WORDS);
  });
});

describe("the [clear] and [compact] words", () => {
  it("takes either of them, whatever their case", () => {
    for (const word of ["clear", "CLEAR", "Clear"]) {
      deepStrictEqual(parseDirective(`[${word}]`).directive, { settings: {}, clear: true }, word);
    }
    for (const word of ["compact", "COMPACT", "Compact"]) {
      deepStrictEqual(parseDirective(`[${word}]`).directive, { settings: {}, compact: true }, word);
    }
  });

  it("hands back whatever followed, so it can settle the history and then use it", () => {
    const parsed = parseDirective("[compact] now write the release notes");
    deepStrictEqual(parsed.directive, { settings: {}, compact: true });
    strictEqual(parsed.rest, "now write the release notes");
  });

  it("sits alongside the settings and the words that stop things", () => {
    deepStrictEqual(parseDirective("[clear, model=opus] start over").directive, { settings: { model: "opus" }, clear: true });
    deepStrictEqual(parseDirective("[exit, clear]").directive, { settings: {}, exit: true, clear: true });
    deepStrictEqual(parseDirective("[stop, compact]").directive, { settings: {}, interrupt: true, compact: true });
  });

  it("refuses to do both at once rather than picking one", () => {
    const parsed = parseDirective("[clear, compact] go");
    deepStrictEqual(parsed.directive, { settings: {} });
    match(parsed.problem ?? "", /clear and to compact at once/);
  });

  it("leaves a bare word it does not know alone, group and all", () => {
    for (const body of ["[cleared] go", "[compacting] go", "[clear it] go"]) {
      deepStrictEqual(parseDirective(body).directive, { settings: {} }, body);
      strictEqual(parseDirective(body).rest, body);
    }
  });

  it("says the same thing in the README as it does here", () => {
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");
    const documented = (heading: string): Set<string> => {
      const block = new RegExp(`${heading}[\\s\\S]*?\`\`\`\\n([\\s\\S]*?)\`\`\``).exec(readme)?.[1];
      if (block === undefined) throw new Error(`the README no longer lists the words under '${heading}'`);
      return new Set(
        block
          .split(/\n|\s{2,}/)
          .map((word) => word.trim())
          .filter((word) => word !== ""),
      );
    };
    deepStrictEqual(documented("## Clearing the context"), CLEAR_WORDS);
    deepStrictEqual(documented("## Compacting the context"), COMPACT_WORDS);
  });
});

describe("the [fork] word", () => {
  it("takes the word it documents, whatever its case", () => {
    for (const word of ["fork", "FORK", "Fork"]) {
      deepStrictEqual(parseDirective(`[${word}]`).directive, { settings: {}, fork: true }, word);
    }
  });

  it("hands back whatever followed it, so the new thread has something to open with", () => {
    const parsed = parseDirective("[fork] work out whether this breaks the importer");
    deepStrictEqual(parsed.directive, { settings: {}, fork: true });
    strictEqual(parsed.rest, "work out whether this breaks the importer");
  });

  it("sits alongside the settings, which settle the thread it makes", () => {
    deepStrictEqual(parseDirective("[fork, model=opus] have a look").directive, { settings: { model: "opus" }, fork: true });
    deepStrictEqual(parseDirective("[effort=max, fork]").directive, { settings: { effort: "max" }, fork: true });
  });

  it("refuses to fork and act on the thread it was written in at once", () => {
    for (const body of ["[fork, stop]", "[exit, fork]", "[fork, clear]", "[fork, compact] go"]) {
      const parsed = parseDirective(body);
      deepStrictEqual(parsed.directive, { settings: {} }, body);
      match(parsed.problem ?? "", /fork this review thread and to act on the thread it was written in/, body);
    }
  });

  it("leaves a bare word it does not know alone, group and all", () => {
    for (const body of ["[forked] go", "[forking] go", "[fork it] go"]) {
      deepStrictEqual(parseDirective(body).directive, { settings: {} }, body);
      strictEqual(parseDirective(body).rest, body);
    }
  });

  it("says the same thing in the README as it does here", () => {
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");
    const block = /## Forking a review thread[\s\S]*?```\n([\s\S]*?)```/.exec(readme)?.[1];
    if (block === undefined) throw new Error("the README no longer lists the fork words under '## Forking a review thread'");

    const documented = block
      .split(/\n|\s{2,}/)
      .map((word) => word.trim())
      .filter((word) => word !== "");
    deepStrictEqual(new Set(documented), FORK_WORDS);
  });
});

describe("reading a reply as approval", () => {
  it("accepts the plain ways of saying yes", () => {
    for (const reply of ["approve", "Approve.", "ALLOW", "yes", "ok", "lgtm", "go ahead", "do it", "proceed", "👍"]) {
      strictEqual(isApproval(reply), true, reply);
    }
  });

  it("treats anything else as a refusal, including a sentence that contains a yes word", () => {
    for (const reply of ["no", "don't do it", "please do it after the release", "approve the other one", "", "nope"]) {
      strictEqual(isApproval(reply), false, reply);
    }
  });

  it("says the same thing in the README as it does here", () => {
    // People answer a permission request by copying a word out of that list, so
    // a word that only one of the two knows about is a bug either way round.
    const readme = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "README.md"), "utf8");
    const block = /### How to answer[\s\S]*?```\n([\s\S]*?)```/.exec(readme)?.[1];
    if (block === undefined) throw new Error("the README no longer lists the approval words under '### How to answer'");

    const documented = block
      .split(/\n|\s{2,}/)
      .map((word) => word.trim())
      .filter((word) => word !== "");
    deepStrictEqual(new Set(documented), APPROVALS);
  });
});
