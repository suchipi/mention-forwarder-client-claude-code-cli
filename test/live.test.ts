import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ConversationSnapshot } from "../src/conversation.ts";
import { createLiveRegistry, type LiveConversation, startPublishing } from "../src/live.ts";
import type { Logger } from "../src/logger.ts";

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const directories: string[] = [];

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "mfcc-live-"));
  directories.push(path);
  return path;
}

after(() => {
  for (const path of directories) rmSync(path, { recursive: true, force: true });
});

function snapshot(over: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    conversationKey: "github:acme/widgets:7",
    cwd: "/tmp/checkout",
    sessionId: "11111111-2222-3333-4444-555555555555",
    model: "opus",
    effort: "high",
    state: "running",
    thread: {
      platform: "github",
      title: "A test issue",
      url: "https://example.com/issues/7#c1",
      author: "suchipi",
      receivedAt: "2026-08-22T00:00:00.000Z",
    },
    turn: { startedAt: "2026-08-22T00:00:01.000Z", url: "https://example.com/issues/7#c1", author: "suchipi", steers: 0 },
    parked: undefined,
    queued: 0,
    mentions: 1,
    turns: 0,
    ...over,
  };
}

/** A pid that certainly belongs to nothing, because we watched it go. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await once(child, "exit");
  ok(child.pid !== undefined);
  return child.pid;
}

function write(dir: string, name: string, entry: Partial<LiveConversation>): void {
  writeFileSync(join(dir, name), JSON.stringify(entry));
}

describe("the live conversation registry", () => {
  it("publishes this process under its own pid, and lists it back", () => {
    const dir = directory();
    const registry = createLiveRegistry(dir, quiet);

    registry.publish(snapshot());

    deepStrictEqual(readdirSync(dir), [`${process.pid}.json`]);
    const listed = registry.list();
    strictEqual(listed.length, 1);
    strictEqual(listed[0]?.pid, process.pid);
    strictEqual(listed[0]?.conversationKey, "github:acme/widgets:7");
    strictEqual(listed[0]?.thread?.url, "https://example.com/issues/7#c1");
    ok(Date.parse(listed[0]?.updatedAt ?? "") > 0, "no updatedAt to spot an abandoned entry by");
  });

  it("overwrites its own entry rather than adding another", () => {
    const dir = directory();
    const registry = createLiveRegistry(dir, quiet);

    registry.publish(snapshot({ turns: 1 }));
    registry.publish(snapshot({ turns: 2 }));

    strictEqual(registry.list().length, 1);
    strictEqual(registry.list()[0]?.turns, 2);
  });

  it("leaves nothing behind when it is removed", () => {
    const dir = directory();
    const registry = createLiveRegistry(dir, quiet);

    registry.publish(snapshot());
    registry.remove();
    registry.remove();

    deepStrictEqual(registry.list(), []);
  });

  it("lists the conversations of other processes too, oldest first", () => {
    const dir = directory();
    const registry = createLiveRegistry(dir, quiet);
    const other = {
      ...snapshot({ conversationKey: "slack:C1:1" }),
      pid: process.pid,
      startedAt: "2020-01-01T00:00:00.000Z",
      updatedAt: new Date().toISOString(),
    };
    // Its own pid, since only a live one is listed, under another process's name.
    write(dir, "999999.json", { ...other, pid: process.pid });
    registry.publish(snapshot());

    const keys = registry.list().map((one) => one.conversationKey);
    deepStrictEqual(keys, ["slack:C1:1", "github:acme/widgets:7"]);
  });

  it("drops, and deletes, an entry whose process has gone", async () => {
    const dir = directory();
    const registry = createLiveRegistry(dir, quiet);
    const pid = await deadPid();
    write(dir, `${pid}.json`, { ...snapshot(), pid, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

    deepStrictEqual(registry.list(), []);
    deepStrictEqual(readdirSync(dir), []);
  });

  it("drops an entry that stopped publishing, even though its pid is in use", () => {
    const dir = directory();
    const registry = createLiveRegistry(dir, quiet);
    const old = new Date(Date.now() - 600000).toISOString();
    write(dir, "12345.json", { ...snapshot(), pid: process.pid, startedAt: old, updatedAt: old });

    deepStrictEqual(registry.list(), []);
  });

  it("ignores a file it cannot read rather than losing the whole list", () => {
    const dir = directory();
    const registry = createLiveRegistry(dir, quiet);
    writeFileSync(join(dir, "half-written.json"), "{\"pid\":");
    writeFileSync(join(dir, "notes.txt"), "not mine");
    registry.publish(snapshot());

    strictEqual(registry.list().length, 1);
    ok(readdirSync(dir).includes("half-written.json"), "a file it could not read was deleted");
  });

  it("is empty, and quiet, before anything has published", () => {
    deepStrictEqual(createLiveRegistry(join(directory(), "not-there"), quiet).list(), []);
  });

  it("writes the entry aside and renames it, so a reader cannot catch it half done", () => {
    const dir = directory();
    createLiveRegistry(dir, quiet).publish(snapshot());
    const raw = readFileSync(join(dir, `${process.pid}.json`), "utf8");
    ok(raw.endsWith("\n"), "the published entry was truncated");
    strictEqual((JSON.parse(raw) as LiveConversation).state, "running");
  });
});

describe("publishing what this process is doing", () => {
  it("publishes at once, and again when the conversation has moved on", async () => {
    const dir = directory();
    const registry = createLiveRegistry(dir, quiet);
    let now = snapshot({ state: "running", turns: 0 });
    const publisher = startPublishing(registry, () => now);

    try {
      strictEqual(registry.list()[0]?.turns, 0);
      now = snapshot({ state: "idle", turn: undefined, turns: 1 });

      const deadline = Date.now() + 5000;
      for (;;) {
        if (registry.list()[0]?.turns === 1) break;
        ok(Date.now() < deadline, "the changed snapshot was never published");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      strictEqual(registry.list()[0]?.state, "idle");
    } finally {
      publisher.stop();
    }
  });
});
