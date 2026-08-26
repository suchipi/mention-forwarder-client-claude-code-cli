import { createServer, type Server } from "node:http";
import { hostname } from "node:os";
import type { LiveRegistry } from "./live.ts";
import type { Logger } from "./logger.ts";

/**
 * Names a `Host:` header may carry, besides an address that is local anyway: what
 * a browser on this machine, or on the network it is on, has in its address bar.
 */
function allowedNames(): string[] {
  const own = hostname().toLowerCase();
  return ["localhost", own, `${own}.local`, own.replace(/\.local$/, "")];
}

/**
 * Whether an address belongs to this machine or the network it is on: loopback,
 * the private ranges, link-local, and the shared range a mesh VPN hands out.
 *
 * This is what keeps the view off the internet now that it is not bound to
 * loopback. It is deliberately about ranges rather than about a particular
 * interface: which of them is "the" local network is not a thing a program can
 * know, and a wrong guess here would lock somebody out of their own bot.
 */
export function isLocalAddress(address: string | undefined): boolean {
  if (address === undefined || address === "") return false;
  // A dual-stack listener reports an IPv4 peer in this form.
  const bare = (address.startsWith("::ffff:") ? address.slice(7) : address).toLowerCase();

  const parts = bare.split(".");
  if (parts.length === 4) {
    const [a, b] = parts.map(Number);
    if (a === undefined || b === undefined || !Number.isInteger(a) || !Number.isInteger(b)) return false;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    // Link-local, for a direct cable or a network with no DHCP.
    if (a === 169 && b === 254) return true;
    // 100.64/10 is the shared range Tailscale and the like address peers in.
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (bare === "::1") return true;
  const head = Number.parseInt(bare.split(":")[0] ?? "", 16);
  if (!Number.isInteger(head)) return false;
  // fc00::/7, the unique local addresses, and fe80::/10, the link-local ones.
  return (head & 0xfe00) === 0xfc00 || (head & 0xffc0) === 0xfe80;
}

/**
 * Whether a `Host:` header is one this view should answer to.
 *
 * A browser sends whatever is in the address bar, so a name somebody else's DNS
 * points at this machine would otherwise reach the view through a browser that
 * can already get to it. An address is judged as an address; anything else has to
 * be a name this machine actually goes by.
 */
function hostIsLocal(header: string | undefined): boolean {
  const host = hostOf(header);
  if (host === "") return false;
  const unbracketed = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (/^[\d.]+$/.test(unbracketed) || unbracketed.includes(":")) return isLocalAddress(unbracketed);
  return allowedNames().includes(host);
}

/**
 * How long before trying the port again after finding it taken. One process per
 * conversation means several of them race for it; the losers keep trying, so the
 * view outlives whichever process happened to win.
 */
const RETRY_MS = 10000;

export type WebView = { close(): Promise<void> };

export type WebViewOptions = {
  port: number;
  registry: LiveRegistry;
  log: Logger;
  /**
   * Whether serving is reason enough for the process to stay alive. False for a
   * conversation, which must not outlive its own work; true for `--web-only`,
   * where serving is the whole job.
   */
  hold?: boolean;
};

function hostOf(header: string | undefined): string {
  if (header === undefined) return "";
  // An IPv6 host is bracketed, so the last colon is the port separator.
  const colon = header.lastIndexOf(":");
  const bracket = header.lastIndexOf("]");
  return (colon > bracket ? header.slice(0, colon) : header).toLowerCase();
}

/**
 * A read-only list of every conversation running on this machine, served to this
 * machine and the network it is on.
 *
 * The list comes from the registry rather than from this process, which only
 * knows its own thread. Whichever process gets the port serves for all of them,
 * and the rest carry on without a view of their own.
 */
export function startWebView({ port, registry, log, hold = false }: WebViewOptions): WebView {
  let server: Server | undefined;
  let retry: NodeJS.Timeout | undefined;
  let closed = false;
  let complained = false;

  function serve(): void {
    if (closed) return;

    const next = createServer((request, response) => {
      const from = request.socket.remoteAddress;
      if (!isLocalAddress(from) || !hostIsLocal(request.headers.host)) {
        log.warn("refused a request to the web view", { from, host: request.headers.host });
        response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        response.end("This view is only served to this machine and its local network.\n");
        return;
      }

      const path = (request.url ?? "/").split("?")[0];
      if (path === "/conversations.json") {
        const body = JSON.stringify({ now: new Date().toISOString(), conversations: registry.list() });
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(body);
        return;
      }
      if (path === "/" || path === "/index.html") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(PAGE);
        return;
      }
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("No such page here. The list is at /.\n");
    });

    next.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        if (!complained) {
          complained = true;
          log.info("another conversation is serving the web view", { url: `http://127.0.0.1:${port}` });
        }
        retry = setTimeout(serve, RETRY_MS);
        // Waiting for the port is the job in `hold` mode, so the wait has to keep
        // the process alive as much as the serving would.
        if (!hold) retry.unref();
        return;
      }
      log.warn("the web view failed", { port, error: error.message });
    });

    next.on("listening", () => {
      server = next;
      complained = false;
      log.info("serving the web view", { url: `http://127.0.0.1:${port}`, alsoFrom: "this machine's local network" });
    });

    // Every interface, so another device on the network can reach it; what may
    // read it is decided per request instead, by the address it came from.
    next.listen(port);
    // Unreferenced so a view nobody is looking at cannot hold a conversation's
    // process open past the last mention.
    if (!hold) next.unref();
  }

  serve();

  return {
    close() {
      closed = true;
      if (retry !== undefined) clearTimeout(retry);
      const running = server;
      server = undefined;
      if (running === undefined) return Promise.resolve();
      return new Promise<void>((resolve) => running.close(() => resolve()));
    },
  };
}

/** Self-contained on purpose: a view of a local bot should not fetch anything from the internet. */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Running conversations</title>
<!-- An empty icon, so a browser does not ask for one this program would answer 404 to. -->
<link rel="icon" href="data:,">
<style>
  :root {
    color-scheme: light dark;
    --page: #f6f7f9;
    --card: #ffffff;
    --line: #e2e5ea;
    --text: #1b1d21;
    --dim: #6b7280;
    --link: #1a56db;
    --running: #1f7a4d;
    --waiting: #a15c00;
    --idle: #6b7280;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --page: #14161a;
      --card: #1c1f24;
      --line: #2c3138;
      --text: #e6e8eb;
      --dim: #9aa2ad;
      --link: #7aa7ff;
      --running: #57d295;
      --waiting: #e0a44a;
      --idle: #9aa2ad;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 2rem 1.25rem 4rem;
    background: var(--page);
    color: var(--text);
    font: 15px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 54rem; margin: 0 auto; }
  h1 { font-size: 1.35rem; margin: 0 0 .25rem; }
  .sub { color: var(--dim); font-size: .85rem; margin: 0 0 1.5rem; }
  ol { list-style: none; margin: 0; padding: 0; display: grid; gap: .75rem; }
  li {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: .9rem 1rem;
  }
  .top { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; }
  .badge {
    font-size: .72rem;
    font-weight: 600;
    letter-spacing: .04em;
    text-transform: uppercase;
    padding: .1rem .45rem;
    border-radius: 999px;
    border: 1px solid currentColor;
    white-space: nowrap;
  }
  .badge.running { color: var(--running); }
  .badge.waiting { color: var(--waiting); }
  .badge.idle { color: var(--idle); }
  .title { font-weight: 600; font-size: 1rem; }
  a { color: var(--link); }
  .doing { margin: .5rem 0 0; }
  .meta { margin: .35rem 0 0; color: var(--dim); font-size: .82rem; }
  .meta span:not(:last-child)::after { content: " · "; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .95em; }
  .empty { color: var(--dim); background: var(--card); border: 1px dashed var(--line); border-radius: 10px; padding: 1.5rem; text-align: center; }
</style>
</head>
<body>
<main>
  <h1>Running conversations</h1>
  <p class="sub" id="sub">Loading…</p>
  <ol id="list"></ol>
</main>
<script>
const list = document.getElementById("list");
const sub = document.getElementById("sub");

function since(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m " + (seconds % 60) + "s";
  const hours = Math.floor(minutes / 60);
  return hours + "h " + (minutes % 60) + "m";
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function name(one) {
  const thread = one.thread || {};
  return thread.title || one.conversationKey || "a conversation";
}

function doing(one) {
  if (one.parked) {
    const what = one.parked.isQuestion ? "a question it asked" : one.parked.tool;
    return "Waiting on " + what + " for " + since(one.parked.since) + ".";
  }
  if (one.turn) {
    const steers = one.turn.steers === 0 ? "" : ", steered " + one.turn.steers + "×";
    return "Working for " + since(one.turn.startedAt) + steers + ".";
  }
  return "Idle. Last mention " + since(one.thread && one.thread.receivedAt ? one.thread.receivedAt : one.startedAt) + " ago.";
}

function card(one) {
  const item = element("li");

  const top = element("div", "top");
  top.append(element("span", "badge " + one.state, one.state));
  const title = element("span", "title");
  if (one.thread && one.thread.url) {
    const link = element("a", null, name(one));
    link.href = one.thread.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    title.append(link);
  } else {
    title.textContent = name(one);
  }
  top.append(title);
  item.append(top);

  item.append(element("p", "doing", doing(one)));

  const meta = element("p", "meta");
  const bits = [];
  if (one.thread && one.thread.platform) bits.push(one.thread.platform);
  if (one.thread && one.thread.author) bits.push("last from " + one.thread.author);
  bits.push((one.model || "the default model") + (one.effort ? ", " + one.effort + " effort" : ""));
  bits.push(
    one.turns + (one.turns === 1 ? " turn" : " turns") + " of " + one.mentions + (one.mentions === 1 ? " mention" : " mentions"),
  );
  if (one.queued > 0) bits.push(one.queued + " queued");
  bits.push("pid " + one.pid);
  for (const bit of bits) meta.append(element("span", null, bit));
  item.append(meta);

  const where = element("p", "meta");
  where.append(element("span", null, one.cwd));
  if (one.sessionId) where.append(element("span", null, "session " + one.sessionId.slice(0, 8)));
  item.append(where);

  return item;
}

async function refresh() {
  let payload;
  try {
    payload = await (await fetch("/conversations.json")).json();
  } catch (error) {
    sub.textContent = "Cannot reach the bot: " + error;
    return;
  }
  const running = payload.conversations;
  sub.textContent = running.length === 0
    ? "Nothing running."
    : running.length + (running.length === 1 ? " conversation" : " conversations") + ", refreshed every 2s.";
  list.replaceChildren(...running.map(card));
  if (running.length === 0) {
    list.append(element("li", "empty", "No conversation has a process right now. One starts when the next mention arrives."));
  }
}

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>
`;
