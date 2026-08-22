import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseDirective } from "../src/directive.ts";
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
