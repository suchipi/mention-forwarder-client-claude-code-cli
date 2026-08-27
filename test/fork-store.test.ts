import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { createForkStore, type ForkStore } from "../src/fork-store.ts";
import type { Logger } from "../src/logger.ts";

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const directories: string[] = [];

after(() => {
  for (const path of directories) rmSync(path, { recursive: true, force: true });
});

/** A store over a fork file holding `lines`, or over none at all when nothing is given. */
function store(lines?: string[]): ForkStore {
  const directory = mkdtempSync(join(tmpdir(), "mfcc-forks-"));
  directories.push(directory);
  const path = join(directory, "forks", "forks.jsonl");
  const made = createForkStore(path, quiet);
  if (lines !== undefined) writeFileSync(path, `${lines.join("\n")}\n`);
  return made;
}

function line(url: string, from: string): string {
  return JSON.stringify({ url, from });
}

describe("what a thread came out of", () => {
  it("keeps nothing, and finds nothing, when there is no file to keep it in", () => {
    const off = createForkStore(undefined, quiet);
    strictEqual(off.path, undefined);
    strictEqual(off.directory, undefined);
    strictEqual(off.parentOf("https://github.com/acme/widgets/pull/12"), undefined);
  });

  it("makes the directory it will be written in, since the agent is handed it", () => {
    const made = store();
    ok(made.directory !== undefined && existsSync(made.directory));
    strictEqual(made.directory, dirname(made.path ?? ""));
  });

  it("finds the thread that opened the pull request a mention arrived on", () => {
    const forks = store([line("https://github.com/acme/widgets/pull/12", "slack:T0:C0:1.1")]);
    strictEqual(
      forks.parentOf("https://github.com/acme/widgets/pull/12#issuecomment-9")?.from,
      "slack:T0:C0:1.1",
    );
  });

  it("matches the thread itself, and anything under it, however the url is written", () => {
    const forks = store([line("https://github.com/acme/widgets/pull/12", "slack:1")]);
    for (const arrived of [
      "https://github.com/acme/widgets/pull/12",
      "https://github.com/acme/widgets/pull/12/",
      "https://github.com/acme/widgets/pull/12#discussion_r7",
      "https://github.com/acme/widgets/pull/12?w=1",
      "https://github.com/acme/widgets/pull/12/files#r7",
      "https://GitHub.com/acme/widgets/pull/12#issuecomment-9",
    ]) {
      strictEqual(forks.parentOf(arrived)?.from, "slack:1", arrived);
    }
  });

  it("does not take a longer number for the one it recorded", () => {
    const forks = store([line("https://github.com/acme/widgets/pull/12", "slack:1")]);
    strictEqual(forks.parentOf("https://github.com/acme/widgets/pull/123"), undefined);
    strictEqual(forks.parentOf("https://github.com/acme/widgets/pull/1"), undefined);
    strictEqual(forks.parentOf("https://github.com/acme/other/pull/12"), undefined);
  });

  it("lets the newest claim on a url win", () => {
    const forks = store([
      line("https://github.com/acme/widgets/pull/12", "slack:first"),
      line("https://github.com/acme/widgets/pull/12", "slack:second"),
    ]);
    strictEqual(forks.parentOf("https://github.com/acme/widgets/pull/12")?.from, "slack:second");
  });

  it("reads past a line that is not a fork request rather than giving up on the file", () => {
    const forks = store([
      "",
      "not json at all",
      JSON.stringify({ url: "https://github.com/acme/widgets/pull/12" }),
      JSON.stringify(["https://github.com/acme/widgets/pull/12", "slack:1"]),
      line("https://github.com/acme/widgets/pull/12", "slack:1"),
      "{ half a line",
    ]);
    strictEqual(forks.parentOf("https://github.com/acme/widgets/pull/12#issuecomment-9")?.from, "slack:1");
  });

  it("finds nothing before anything has been recorded", () => {
    strictEqual(store().parentOf("https://github.com/acme/widgets/pull/12"), undefined);
  });

  it("finds nothing for a mention that carried no url", () => {
    const forks = store([line("https://github.com/acme/widgets/pull/12", "slack:1")]);
    strictEqual(forks.parentOf(""), undefined);
  });
});
