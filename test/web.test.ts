import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { once } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { LiveConversation, LiveRegistry } from "../src/live.ts";
import type { Logger } from "../src/logger.ts";
import type { Moment } from "../src/transcript.ts";
import { isLocalAddress, startWebView, type WebView } from "../src/web.ts";

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const views: WebView[] = [];
const directories: string[] = [];

after(async () => {
  for (const view of views) await view.close();
  for (const path of directories) rmSync(path, { recursive: true, force: true });
});

const entry: LiveConversation = {
  pid: 4242,
  startedAt: "2026-08-22T00:00:00.000Z",
  updatedAt: "2026-08-22T00:00:05.000Z",
  conversationKey: "github:acme/widgets:7",
  cwd: "/tmp/checkout",
  sessionId: "11111111-2222-3333-4444-555555555555",
  model: "opus",
  effort: "high",
  state: "waiting",
  thread: {
    platform: "github",
    title: "A test issue",
    url: "https://example.com/issues/7#c1",
    author: "suchipi",
    receivedAt: "2026-08-22T00:00:00.000Z",
  },
  turn: { startedAt: "2026-08-22T00:00:01.000Z", url: "https://example.com/issues/7#c1", author: "suchipi", steers: 1 },
  parked: { tool: "Write", isQuestion: false, since: "2026-08-22T00:00:04.000Z" },
  queued: 2,
  mentions: 3,
  turns: 1,
};

function registryOf(entries: LiveConversation[]): LiveRegistry {
  return { publish: () => {}, remove: () => {}, list: () => entries };
}

/** A port nothing is listening on, taken and given straight back. */
async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  ok(address !== null && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

type Response = { status: number; body: string };

/** A request target `http.request` would refuse to send, written onto the socket by hand. */
function raw(port: number, target: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let all = "";
    socket.setEncoding("utf8");
    // A target the view chokes on is answered by nothing at all, which without
    // this would hang the run rather than fail it.
    socket.setTimeout(5000, () => socket.destroy(new Error(`nothing answered ${target}`)));
    socket.on("data", (chunk: string) => (all += chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve({ status: Number(all.split(" ")[1] ?? 0), body: all }));
  });
}

function get(port: number, path: string, host?: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const call = request(
      { host: "127.0.0.1", port, path, method: "GET", ...(host === undefined ? {} : { headers: { host } }) },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    call.on("error", reject);
    call.end();
  });
}

/** A projects directory holding one line per given message, as Claude Code lays them out. */
function transcriptOf(said: string[], sessionId = entry.sessionId ?? ""): string {
  const projects = mkdtempSync(join(tmpdir(), "mfcc-web-projects-"));
  directories.push(projects);
  mkdirSync(join(projects, "-tmp-checkout"), { recursive: true });
  const file = join(projects, "-tmp-checkout", `${sessionId}.jsonl`);
  writeFileSync(file, "");
  for (const text of said) appendFileSync(file, `${line(text)}\n`);
  return projects;
}

function line(text: string): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-22T00:00:01.000Z",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });
}

function appendTo(projects: string, text: string, sessionId = entry.sessionId ?? ""): void {
  appendFileSync(join(projects, "-tmp-checkout", `${sessionId}.jsonl`), `${line(text)}\n`);
}

type Page = { conversation?: LiveConversation; moments?: Moment[]; from?: number; next?: number; missing?: boolean };

async function view(entries: LiveConversation[] = [entry], projects?: string): Promise<number> {
  const port = await freePort();
  const started = startWebView({ port, registry: registryOf(entries), log: quiet, ...(projects === undefined ? {} : { projects }) });
  views.push(started);
  // `listen` resolves on its own thread; the first request would otherwise race it.
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await get(port, "/conversations.json");
      return port;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

describe("the web view", () => {
  it("serves the list as JSON", async () => {
    const port = await view();
    const { status, body } = await get(port, "/conversations.json");

    strictEqual(status, 200);
    const payload = JSON.parse(body) as { now: string; conversations: LiveConversation[] };
    ok(Date.parse(payload.now) > 0);
    strictEqual(payload.conversations.length, 1);
    strictEqual(payload.conversations[0]?.thread?.url, "https://example.com/issues/7#c1");
    strictEqual(payload.conversations[0]?.parked?.tool, "Write");
  });

  it("serves a page that needs nothing off this machine", async () => {
    const port = await view();
    const { status, body } = await get(port, "/");

    strictEqual(status, 200);
    match(body, /<title>Running conversations<\/title>/);
    ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(body), "the page loads something from the internet");
  });

  it("answers a query string on the page, since a browser may add one", async () => {
    const port = await view();
    strictEqual((await get(port, "/?nocache=1")).status, 200);
  });

  it("turns down a target that is not an address, rather than taking the process with it", async () => {
    const port = await view();
    // Node's own parser passes these along, and `URL` will not take either one.
    for (const target of ["//", "/\\"]) {
      strictEqual((await raw(port, target)).status, 400, `${target} was answered`);
    }
    // Still serving, which is the point of the test.
    strictEqual((await get(port, "/conversations.json")).status, 200);
  });

  it("says so for anything else", async () => {
    const port = await view();
    const { status, body } = await get(port, "/nope");

    strictEqual(status, 404);
    match(body, /The list is at \//);
  });

  it("refuses a request that reached it under a name this machine does not go by", async () => {
    const port = await view();
    const { status, body } = await get(port, "/conversations.json", `pointed-at-loopback.example.com:${port}`);

    strictEqual(status, 403);
    match(body, /this machine and its local network/);
  });

  it("takes the names and addresses this machine is actually reachable at", async () => {
    const port = await view();
    for (const host of [
      `localhost:${port}`,
      "127.0.0.1",
      `[::1]:${port}`,
      // What a browser on another device on the network has in its address bar.
      `192.168.1.218:${port}`,
      hostname(),
      `${hostname()}.local:${port}`,
    ]) {
      strictEqual((await get(port, "/conversations.json", host)).status, 200, `refused Host: ${host}`);
    }
  });

  it("refuses a Host that is a public address, which is nothing it is reachable at", async () => {
    const port = await view();
    strictEqual((await get(port, "/conversations.json", `93.184.216.34:${port}`)).status, 403);
  });

  it("takes loopback, the private ranges, link-local, and a mesh VPN's range", () => {
    for (const address of [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.7",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.218",
      "169.254.10.1",
      "100.101.102.103",
      "::1",
      "fd7a:115c:a1e0::1",
      "fc00::1",
      "fe80::1cff:fe00:1",
      // A dual-stack listener reports an IPv4 peer this way.
      "::ffff:192.168.1.218",
    ]) {
      ok(isLocalAddress(address), `${address} was refused`);
    }
  });

  it("refuses everything else, including the ranges next to the private ones", () => {
    for (const address of [
      "8.8.8.8",
      "93.184.216.34",
      "172.15.0.1",
      "172.32.0.1",
      "192.167.1.1",
      "192.169.1.1",
      "100.63.255.255",
      "100.128.0.1",
      "11.0.0.1",
      "2606:2800:220:1:248:1893:25c8:1946",
      "fb00::1",
      "fec0::1",
      "::ffff:8.8.8.8",
      "",
      undefined,
      "nonsense",
    ]) {
      ok(!isLocalAddress(address), `${address} was served`);
    }
  });

  it("leaves the port to whichever process has it, rather than failing", async () => {
    const port = await view();
    const second = startWebView({ port, registry: registryOf([]), log: quiet });
    views.push(second);

    // The one already listening still answers, and nothing threw.
    strictEqual(JSON.parse((await get(port, "/conversations.json")).body).conversations.length, 1);
    await second.close();
  });

  it("serves an empty list when nothing is running", async () => {
    const port = await view([]);
    strictEqual(JSON.parse((await get(port, "/conversations.json")).body).conversations.length, 0);
  });
});

describe("a session's transcript", () => {
  it("serves what the session has done, and what the conversation is doing now", async () => {
    const port = await view([entry], transcriptOf(["Having a look.", "Found it."]));
    const { status, body } = await get(port, `/session.json?id=${entry.sessionId}`);

    strictEqual(status, 200);
    const page: Page = JSON.parse(body);
    deepStrictEqual(page.moments?.map((one) => one.text), ["Having a look.", "Found it."]);
    strictEqual(page.conversation?.parked?.tool, "Write");
  });

  it("serves only what has been added since, so watching one costs a line at a time", async () => {
    const projects = transcriptOf(["Having a look."]);
    const port = await view([entry], projects);
    const first: Page = JSON.parse((await get(port, `/session.json?id=${entry.sessionId}`)).body);

    appendTo(projects, "Found it.");
    const next: Page = JSON.parse((await get(port, `/session.json?id=${entry.sessionId}&from=${first.next}`)).body);

    deepStrictEqual(next.moments?.map((one) => one.text), ["Found it."]);
    strictEqual(next.from, first.next);
  });

  it("reads from the start when asked from nowhere in particular", async () => {
    const port = await view([entry], transcriptOf(["Having a look."]));
    for (const from of ["", "-5", "nonsense", "1e30"]) {
      const page: Page = JSON.parse((await get(port, `/session.json?id=${entry.sessionId}&from=${from}`)).body);
      strictEqual(page.from, 0, `from=${from} was taken as somewhere`);
      strictEqual(page.moments?.length, 1);
    }
  });

  it("says so when Claude Code has not written the session down yet", async () => {
    const port = await view([entry], transcriptOf([], "99999999-2222-3333-4444-555555555555"));
    const page: Page = JSON.parse((await get(port, `/session.json?id=${entry.sessionId}`)).body);

    strictEqual(page.missing, true);
    strictEqual(page.conversation?.sessionId, entry.sessionId);
  });

  it("refuses a session no conversation on the list is on, however it was guessed", async () => {
    const port = await view([entry], transcriptOf(["Having a look."]));
    for (const id of ["", "66666666-7777-8888-9999-000000000000", "../-tmp-checkout/x"]) {
      const { status, body } = await get(port, `/session.json?id=${encodeURIComponent(id)}`);
      strictEqual(status, 404, `${id} was served`);
      match(body, /No conversation running here is on that session/);
    }
  });

  it("serves the page at the session's own address, since that is what it reads its id from", async () => {
    const port = await view();
    const { status, body } = await get(port, `/session/${entry.sessionId}`);

    strictEqual(status, 200);
    match(body, /session\.json\?id=/);
    ok(!/https?:\/\/(?!127\.0\.0\.1)/.test(body), "the page loads something from the internet");
  });

  it("is what the list points every conversation at", async () => {
    const port = await view();
    match((await get(port, "/")).body, /"\/session\/"/);
  });
});
