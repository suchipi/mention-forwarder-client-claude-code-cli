import { match, ok, strictEqual } from "node:assert/strict";
import { once } from "node:events";
import { createServer, request } from "node:http";
import { hostname } from "node:os";
import { after, describe, it } from "node:test";
import type { LiveConversation, LiveRegistry } from "../src/live.ts";
import type { Logger } from "../src/logger.ts";
import { isLocalAddress, startWebView, type WebView } from "../src/web.ts";

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const views: WebView[] = [];

after(async () => {
  for (const view of views) await view.close();
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

async function view(entries: LiveConversation[] = [entry]): Promise<number> {
  const port = await freePort();
  const started = startWebView({ port, registry: registryOf(entries), log: quiet });
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
