import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT_WORDS, INTERRUPT_WORDS, parseDirective } from "../src/directive.ts";
import { APPROVALS, isApproval } from "../src/answer.ts";

describe("the [model=..., effort=...] group", () => {
  it("reads both settings and hands back the rest", () => {
    const parsed = parseDirective("[model=opus, effort=high] work out why the deploy hangs");
    deepStrictEqual(parsed.directive, { model: "opus", effort: "high" });
    strictEqual(parsed.rest, "work out why the deploy hangs");
  });

  it("takes either setting alone, in either order", () => {
    deepStrictEqual(parseDirective("[effort=max] go").directive, { effort: "max" });
    deepStrictEqual(parseDirective("[effort=low, model=haiku] go").directive, { model: "haiku", effort: "low" });
  });

  it("does not care about the case of a setting name or an effort level", () => {
    deepStrictEqual(parseDirective("[MODEL=opus, Effort=HIGH] go").directive, { model: "opus", effort: "high" });
  });

  it("leaves a group with nothing after it, so it can be answered on its own", () => {
    const parsed = parseDirective("[model=sonnet]");
    deepStrictEqual(parsed.directive, { model: "sonnet" });
    strictEqual(parsed.rest, "");
  });

  it("leaves ordinary brackets alone", () => {
    for (const body of ["[WIP] fix the test", "[bug] it crashes", "[see #12] look here", "just some text"]) {
      deepStrictEqual(parseDirective(body).directive, {}, body);
      strictEqual(parseDirective(body).rest, body);
    }
  });

  it("reports an effort level it does not know instead of ignoring it", () => {
    const parsed = parseDirective("[effort=turbo] go");
    deepStrictEqual(parsed.directive, {});
    match(parsed.problem ?? "", /effort level `turbo`/);
  });

  it("reports a model set to nothing", () => {
    match(parseDirective("[model=] go").problem ?? "", /set `model` to nothing/);
  });
});

describe("the [interrupt] word", () => {
  it("takes any of the words it documents, whatever their case", () => {
    for (const word of ["interrupt", "stop", "int", "STOP", "Interrupt"]) {
      deepStrictEqual(parseDirective(`[${word}]`).directive, { interrupt: true }, word);
    }
  });

  it("hands back whatever followed it, so it can stop one thing and start another", () => {
    const parsed = parseDirective("[stop] look at the other branch instead");
    deepStrictEqual(parsed.directive, { interrupt: true });
    strictEqual(parsed.rest, "look at the other branch instead");
  });

  it("sits alongside the settings, in either order", () => {
    deepStrictEqual(parseDirective("[interrupt, model=opus] retry").directive, { model: "opus", interrupt: true });
    deepStrictEqual(parseDirective("[effort=max, stop] retry").directive, { effort: "max", interrupt: true });
  });

  it("leaves a bare word it does not know alone, group and all", () => {
    for (const body of ["[halt] go", "[stopping] go", "[stop it] go"]) {
      deepStrictEqual(parseDirective(body).directive, {}, body);
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
      deepStrictEqual(parseDirective(`[${word}]`).directive, { exit: true }, word);
    }
  });

  it("hands back whatever followed it, so it can end one process and set the next to work", () => {
    const parsed = parseDirective("[exit] have another go at it");
    deepStrictEqual(parsed.directive, { exit: true });
    strictEqual(parsed.rest, "have another go at it");
  });

  it("sits alongside the settings and the interrupt word", () => {
    deepStrictEqual(parseDirective("[exit, model=opus] retry").directive, { model: "opus", exit: true });
    deepStrictEqual(parseDirective("[stop, quit] retry").directive, { interrupt: true, exit: true });
  });

  it("leaves a bare word it does not know alone, group and all", () => {
    for (const body of ["[exited] go", "[quitting] go", "[exit now] go"]) {
      deepStrictEqual(parseDirective(body).directive, {}, body);
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
