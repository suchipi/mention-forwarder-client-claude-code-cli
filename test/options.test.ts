import { deepStrictEqual, match, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { ConfigError, readConfigFile } from "../src/config-file.ts";
import { resolveOptions } from "../src/options.ts";

const directory = mkdtempSync(join(tmpdir(), "mfcc-options-"));
after(() => rmSync(directory, { recursive: true, force: true }));

function configFile(name: string, contents: unknown): string {
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

describe("the settings file", () => {
  it("resolves its paths against its own directory, not the working one", () => {
    const path = configFile("paths.json", { cwd: "repo", stateFile: "state/sessions.json", addDirs: ["extra"] });
    const config = readConfigFile(path);
    strictEqual(config.cwd, join(directory, "repo"));
    strictEqual(config.stateFile, join(directory, "state", "sessions.json"));
    deepStrictEqual(config.addDirs, [join(directory, "extra")]);
  });

  it("refuses a setting it does not know, rather than ignoring it", () => {
    const path = configFile("typo.json", { aproval: "allow" });
    throws(() => readConfigFile(path), (error: Error) => error instanceof ConfigError && /unknown setting "aproval"/.test(error.message));
  });

  it("refuses a setting of the wrong type", () => {
    throws(() => readConfigFile(configFile("wrong.json", { model: 5 })), /must be a string/);
    throws(() => readConfigFile(configFile("wrong2.json", { addDirs: "one" })), /must be a list of strings/);
    throws(() => readConfigFile(configFile("wrong3.json", { askTimeoutSeconds: "10" })), /must be a number/);
  });

  it("is optional when it is the default one, and required when it was asked for", () => {
    deepStrictEqual(readConfigFile(undefined), {});
    throws(() => readConfigFile(join(directory, "missing.json")), /could not read the config file/);
  });
});

describe("resolving the options", () => {
  it("falls back to the built-in defaults", () => {
    const options = resolveOptions({});
    strictEqual(options.binary, "claude");
    strictEqual(options.approval, "ask");
    strictEqual(options.progress, "all");
    strictEqual(options.askTimeoutMs, 0);
    strictEqual(options.logLevel, "info");
    strictEqual(options.cwd, resolve(process.cwd()));
  });

  it("lets a flag win over the file", () => {
    const config = configFile("both.json", { model: "sonnet", approval: "deny" });
    const options = resolveOptions({ config, model: "opus" });
    strictEqual(options.model, "opus");
    strictEqual(options.approval, "deny");
  });

  it("checks the values it knows the shape of", () => {
    throws(() => resolveOptions({ approval: "maybe" }), /--approval must be one of ask, allow, deny/);
    throws(() => resolveOptions({ effort: "turbo" }), /--effort must be one of/);
    throws(() => resolveOptions({ "permission-mode": "yolo" }), /--permission-mode must be one of/);
    throws(() => resolveOptions({ progress: "some" }), /--progress must be one of/);
    throws(() => resolveOptions({ "log-level": "loud" }), /--log-level must be one of/);
    throws(() => resolveOptions({ "ask-timeout": "-1" }), /zero or a positive number/);
  });

  it("turns the ask timeout into milliseconds", () => {
    strictEqual(resolveOptions({ "ask-timeout": "90" }).askTimeoutMs, 90000);
  });

  it("refuses two ways of saying what to do with state", () => {
    throws(() => resolveOptions({ "no-state": true, "state-file": "x.json" }), /contradict each other/);
    strictEqual(resolveOptions({ "no-state": true }).stateFile, undefined);
    match(resolveOptions({}).stateFile ?? "", /mention-forwarder-claude-code[/\\]sessions\.json$/);
  });

  it("takes the extra system prompt from the file, and lets a flag win over it", () => {
    const config = configFile("prompt.json", { appendSystemPrompt: "Work on a branch of your own." });
    strictEqual(resolveOptions({ config }).appendSystemPrompt, "Work on a branch of your own.");
    strictEqual(resolveOptions({ config, "append-system-prompt": "Stay on main." }).appendSystemPrompt, "Stay on main.");
    strictEqual(resolveOptions({}).appendSystemPrompt, undefined);
  });

  it("keeps claude's own arguments in the order they were given", () => {
    const options = resolveOptions({ "claude-arg": ["--mcp-config", "servers.json"] });
    deepStrictEqual(options.extraArgs, ["--mcp-config", "servers.json"]);
  });
});
