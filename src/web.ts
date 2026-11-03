import { createServer, type Server } from "node:http";
import { hostname } from "node:os";
import type { LiveRegistry } from "./live.ts";
import type { Logger } from "./logger.ts";
import { findTranscript, projectsDirectory, readTranscript } from "./transcript.ts";

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
 * The request's address, or nothing when it is not one. Node's parser hands over
 * targets `URL` will not take, `//` and `/\` among them, and a view is never a
 * reason for a conversation's process to be gone.
 */
function addressOf(target: string | undefined): URL | undefined {
  try {
    // A base only so this parses; nothing about it reaches the response.
    return new URL(target ?? "/", "http://view.invalid");
  } catch {
    return undefined;
  }
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
  /** Where Claude Code files its sessions. Only a test has reason to say. */
  projects?: string;
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
export function startWebView({
  port,
  registry,
  log,
  hold = false,
  projects = projectsDirectory(),
}: WebViewOptions): WebView {
  let server: Server | undefined;
  let retry: NodeJS.Timeout | undefined;
  let closed = false;
  let complained = false;

  /**
   * One session's transcript, from `from` bytes in, alongside the conversation it
   * belongs to so the page can say what that conversation is doing now.
   *
   * Only a session the list already names. This view has no password, so a
   * session id somebody guessed must not be a way to read back a transcript that
   * was never shown here.
   */
  function transcriptFor(url: URL): { status: number; body: string } {
    const sessionId = url.searchParams.get("id") ?? "";
    const conversation = registry.list().find((entry) => entry.sessionId === sessionId);
    if (conversation === undefined) {
      return { status: 404, body: JSON.stringify({ error: "No conversation running here is on that session." }) };
    }

    const file = findTranscript(sessionId, projects);
    // A session Claude Code has not written anything for yet, which is every one
    // of them for the moment between the id arriving and the first line landing.
    if (file === undefined) {
      return { status: 200, body: JSON.stringify({ conversation, from: 0, next: 0, size: 0, moments: [], missing: true }) };
    }

    try {
      const page = readTranscript(file, Number(url.searchParams.get("from")));
      return { status: 200, body: JSON.stringify({ conversation, ...page }) };
    } catch (error) {
      log.warn("could not read a transcript for the web view", {
        file,
        error: error instanceof Error ? error.message : String(error),
      });
      return { status: 200, body: JSON.stringify({ conversation, error: "That transcript could not be read." }) };
    }
  }

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

      const url = addressOf(request.url);
      if (url === undefined) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("That is not an address, so there is nothing here to answer with.\n");
        return;
      }
      const path = url.pathname;

      if (path === "/conversations.json") {
        const body = JSON.stringify({ now: new Date().toISOString(), conversations: registry.list() });
        response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(body);
        return;
      }
      if (path === "/session.json") {
        const { status, body } = transcriptFor(url);
        response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(body);
        return;
      }
      if (path === "/" || path === "/index.html") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(PAGE);
        return;
      }
      // The page reads the session id out of its own address, so every one of
      // them is the same page and there is nothing here to fill in.
      if (path.startsWith("/session/")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(TRANSCRIPT_PAGE);
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

/**
 * What both pages look like. Self-contained on purpose: a view of a local bot
 * should not fetch anything from the internet.
 */
const STYLE = `
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
    --soft: #eceef2;
    --failed: #c0362c;
    --added: #e3f4e8;
    --removed: #fbe7e5;
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
      --soft: #252930;
      --failed: #f07167;
      --added: #1b3326;
      --removed: #3a2023;
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
  a { color: var(--link); }
  .meta { margin: .35rem 0 0; color: var(--dim); font-size: .82rem; }
  .meta span:not(:last-child)::after { content: " · "; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .95em; }
  .empty { color: var(--dim); background: var(--card); border: 1px dashed var(--line); border-radius: 10px; padding: 1.5rem; text-align: center; }
`;

/** Shared by both pages, which build nodes rather than assembling HTML out of what they are shown. */
const ELEMENT = `
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * What to call a conversation. Every slack thread in a channel arrives titled
 * with that channel's id, so the moment the thread started is said alongside it:
 * without that, a busy channel is a column of rows that all read alike.
 */
function name(one) {
  const thread = one.thread || {};
  const title = thread.title || one.conversationKey || "a conversation";
  const started = thread.startedAt ? day(thread.startedAt) : "";
  return started ? title + " \u00b7 " + started : title;
}

function day(iso) {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
`;

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Running conversations</title>
<!-- An empty icon, so a browser does not ask for one this program would answer 404 to. -->
<link rel="icon" href="data:,">
<style>${STYLE}
  li {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: .9rem 1rem;
  }
  .top { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; }
  .title { font-weight: 600; font-size: 1rem; }
  .doing { margin: .5rem 0 0; }
  .asked {
    margin: .45rem 0 0;
    padding-left: .6rem;
    border-left: 2px solid var(--line);
    color: var(--dim);
    font-size: .85rem;
    overflow-wrap: anywhere;
  }
</style>
</head>
<body>
<main>
  <h1>Running conversations</h1>
  <p class="sub" id="sub">Loading…</p>
  <ol id="list"></ol>
</main>
<script>
${ELEMENT}
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
  if (one.thread && one.thread.asked) item.append(element("p", "asked", one.thread.asked));

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
  if (one.sessionId) {
    where.append(element("span", null, "session " + one.sessionId.slice(0, 8)));
    const link = element("a", null, "what it has been doing");
    link.href = "/session/" + encodeURIComponent(one.sessionId);
    const holder = element("span");
    holder.append(link);
    where.append(holder);
  }
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

/**
 * Everything one session has done, in the order it happened. The thread sees only
 * what the agent said, and on `"progress": "final"` not even that until the turn
 * is over; this is where the work in between is legible.
 */
const TRANSCRIPT_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>A session</title>
<link rel="icon" href="data:,">
<style>${STYLE}
  .back { margin: 0 0 .75rem; font-size: .85rem; }
  h1 { display: flex; align-items: baseline; gap: .6rem; flex-wrap: wrap; }
  #about { margin: .4rem 0 1.25rem; }
  #log { display: grid; gap: .75rem; }
  .moment { min-width: 0; }
  .aside { display: grid; gap: .75rem; margin-left: .45rem; padding-left: .9rem; border-left: 2px solid var(--line); }
  .aside > .tag { justify-self: start; }
  .person { margin-top: .75rem; padding: .7rem .9rem; background: var(--soft); border-radius: 10px; }
  #log > .person:first-child { margin-top: 0; }
  .who { margin: 0 0 .3rem; display: flex; gap: .5rem; color: var(--dim); font-size: .75rem; }
  pre.prose { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.6; }
  .thought pre.prose, .result pre.prose { color: var(--dim); }
  .head {
    display: flex;
    align-items: center;
    gap: .5rem;
    flex-wrap: wrap;
    width: 100%;
    margin: 0;
    padding: 0;
    background: none;
    border: 0;
    color: inherit;
    font: inherit;
    text-align: left;
  }
  button.head { cursor: pointer; }
  .thought .head { margin-bottom: .3rem; }
  .icon { flex: none; width: 1rem; height: 1rem; color: var(--dim); }
  .icon svg { display: block; width: 100%; height: 100%; }
  .chevron { margin-left: auto; transition: transform .15s; }
  .call.open .chevron { transform: rotate(90deg); }
  .call.failed > .head > .icon:first-child { color: var(--failed); }
  .chip {
    padding: 0 .4rem;
    border: 1px solid var(--line);
    border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: .8rem;
  }
  .dim { color: var(--dim); font-size: .85rem; }
  .marks:empty { display: none; }
  .tag { color: var(--dim); border: 1px solid var(--line); border-radius: 999px; padding: 0 .4rem; font-size: .7rem; }
  .tag.failed { color: var(--failed); border-color: currentColor; }
  .line, .body { margin: .35rem 0 0 1.5rem; }
  .line {
    padding: .3rem .55rem;
    background: var(--soft);
    border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: .8rem;
    line-height: 1.45;
  }
  /* Clamped on an inner box, since a padded one lets the next line show through its padding. */
  .line > div {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 4;
    overflow: hidden;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .call.open .line > div { display: block; }
  .body { display: none; }
  .call.open .body { display: grid; gap: .6rem; }
  .body p { margin: 0; }
  .label { margin: 0 0 .25rem; color: var(--dim); font-size: .72rem; letter-spacing: .04em; text-transform: uppercase; }
  pre.code {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: .8rem;
    line-height: 1.45;
  }
  pre.output { padding: .45rem .6rem; border: 1px solid var(--line); border-radius: 6px; }
  .failed pre.output { border-color: var(--failed); }
  .diff {
    border: 1px solid var(--line);
    border-radius: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: .8rem;
    line-height: 1.45;
  }
  .diff div { padding: 0 .55rem 0 calc(.55rem + 2ch); text-indent: -2ch; white-space: pre-wrap; overflow-wrap: anywhere; }
  .diff .removed { background: var(--removed); }
  .diff .added { background: var(--added); }
  .diff .removed::before { content: "- "; color: var(--dim); }
  .diff .added::before { content: "+ "; color: var(--dim); }
  .note .head, .note .icon, .note pre.prose { color: var(--waiting); }
  .note pre.prose { margin-left: 1.5rem; font-size: .9rem; }
  .pending { color: var(--dim); font-size: .82rem; font-style: italic; }
  .folded {
    max-height: 14rem;
    overflow: hidden;
    -webkit-mask-image: linear-gradient(to bottom, #000 70%, transparent);
    mask-image: linear-gradient(to bottom, #000 70%, transparent);
  }
  .more {
    margin-top: .5rem;
    padding: .15rem .5rem;
    background: none;
    border: 1px solid var(--line);
    border-radius: 6px;
    color: var(--link);
    font: inherit;
    font-size: .78rem;
    cursor: pointer;
  }
  .cut { margin: .45rem 0 0; color: var(--dim); font-size: .78rem; }
</style>
</head>
<body>
<main>
  <p class="back"><a href="/">← Every running conversation</a></p>
  <h1 id="title">A session</h1>
  <p class="meta" id="about"></p>
  <p class="sub" id="sub">Loading…</p>
  <div id="log"></div>
</main>
<script>
${ELEMENT}
const sessionId = decodeURIComponent(location.pathname.slice("/session/".length));
const title = document.getElementById("title");
const about = document.getElementById("about");
const sub = document.getElementById("sub");
const log = document.getElementById("log");

/** Past this many characters a block is folded, because one file a tool read is longer than a screen. */
const FOLD_CHARS = 1200;

/** A result names only the call it answers, which may have reached the page a refresh earlier. */
const calls = new Map();

let from = 0;
let seen = 0;

/** Lucide's outlines, inlined because this page fetches nothing. */
const ICONS = {
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  write: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6"/><path d="M12 18v-6"/>',
  edit: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  web: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  agent: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
  tool: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  thought: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  warning: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  result: '<polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
};

function icon(which) {
  const holder = element("span", "icon");
  holder.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    ICONS[which] +
    "</svg>";
  return holder;
}

function when(at) {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleTimeString() : "";
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function basename(path) {
  return path.split("/").pop() || path;
}

function foldable(node, long) {
  const holder = element("div");
  holder.append(node);
  if (long) {
    node.classList.add("folded");
    const more = element("button", "more", "Show all");
    more.addEventListener("click", function () {
      node.classList.remove("folded");
      more.remove();
    });
    holder.append(more);
  }
  return holder;
}

function cutNote(cut) {
  return element("p", "cut", cut.toLocaleString() + " more characters were not kept.");
}

function block(className, value, cut) {
  const holder = foldable(element("pre", className, value), value.length > FOLD_CHARS);
  if (cut) holder.append(cutNote(cut));
  return holder;
}

function diff(before, after) {
  const holder = element("div", "diff");
  for (const line of before.split("\\n")) holder.append(element("div", "removed", line));
  for (const line of after.split("\\n")) holder.append(element("div", "added", line));
  return foldable(holder, before.length + after.length > FOLD_CHARS);
}

function lines(input) {
  const start = typeof input.offset === "number" ? input.offset : 1;
  if (typeof input.limit === "number") return "lines " + start + "-" + (start + input.limit - 1);
  return typeof input.offset === "number" ? "from line " + start : "";
}

/**
 * How a call reads on the page: what it was for, and on a row of its own what it
 * was called with, so a long command is not cut short to share a line. Anything
 * else worth seeing waits until the call is opened. A tool not named here is
 * shown with the arguments it was given.
 */
function shape(tool, input) {
  switch (tool) {
    case "Bash":
      return { icon: "terminal", title: text(input.description) || "Run a command", line: text(input.command) };
    case "Read":
      return { icon: "file", title: "Read", file: text(input.file_path), extra: lines(input) };
    case "Write":
      return { icon: "write", title: "Write", file: text(input.file_path), code: text(input.content) };
    case "Edit":
      return {
        icon: "edit",
        title: input.replace_all === true ? "Edit every match in" : "Edit",
        file: text(input.file_path),
        diff: [text(input.old_string), text(input.new_string)],
      };
    case "Grep":
      return { icon: "search", title: "Search" + (text(input.path) ? " in " + basename(input.path) : ""), line: text(input.pattern) };
    case "Glob":
      return { icon: "search", title: "Find files", line: text(input.pattern) };
    case "WebFetch":
      return { icon: "web", title: "Fetch", line: text(input.url), prose: text(input.prompt) };
    case "WebSearch":
      return { icon: "web", title: "Search the web", line: text(input.query) };
    case "Task":
    case "Agent":
      return {
        icon: "agent",
        title: text(input.description) || "Hand off to a subagent",
        extra: text(input.subagent_type),
        prose: text(input.prompt),
      };
  }
  const given = JSON.stringify(input);
  return { icon: "tool", title: tool, line: given === "{}" ? "" : given };
}

function call(one) {
  const tool = one.tool || "a tool";
  let input;
  try {
    input = JSON.parse(one.text);
  } catch (error) {
    input = undefined;
  }
  // Arguments cut short at the server are no longer JSON, and are shown as they came.
  const how = input !== null && typeof input === "object" && !Array.isArray(input)
    ? shape(tool, input)
    : { icon: "tool", title: tool, line: one.text };

  const node = element("div", "moment call");
  const head = element("button", "head");
  head.type = "button";
  head.title = when(one.at);
  head.setAttribute("aria-expanded", "false");
  head.append(icon(how.icon), element("span", null, how.title));
  if (how.file) {
    const chip = element("span", "chip", basename(how.file));
    chip.title = how.file;
    head.append(chip);
  }
  if (how.extra) head.append(element("span", "dim", how.extra));
  const marks = element("span", "marks");
  const chevron = icon("chevron");
  chevron.classList.add("chevron");
  head.append(marks, chevron);
  node.append(head);

  if (how.line) {
    const line = element("div", "line");
    line.append(element("div", null, how.line));
    node.append(line);
  }

  const body = element("div", "body");
  if (how.file) body.append(element("p", "dim", how.file));
  if (how.diff) body.append(diff(how.diff[0], how.diff[1]));
  if (how.code) body.append(block("code", how.code));
  if (how.prose) {
    const asked = block("prose", how.prose);
    asked.prepend(element("p", "label", "What it was asked"));
    body.append(asked);
  }
  if (one.cut) body.append(cutNote(one.cut));
  const output = element("div");
  output.append(element("p", "pending", "Nothing has come back yet."));
  body.append(output);
  node.append(body);

  head.addEventListener("click", function () {
    head.setAttribute("aria-expanded", String(node.classList.toggle("open")));
  });

  calls.set(one.useId, { node: node, marks: marks, output: output });
  return node;
}

function headed(className, iconName, label, at) {
  const node = element("div", "moment " + className);
  const head = element("p", "head");
  head.title = when(at);
  head.append(icon(iconName), element("span", null, label));
  node.append(head);
  return node;
}

/** What came back is shown inside the call it answers, so this returns a node only for a result with no call on the page. */
function answer(one) {
  const asked = calls.get(one.useId);
  if (asked === undefined) {
    const node = headed("result", "result", "What came back", one.at);
    if (one.failed) node.firstChild.append(element("span", "tag failed", "failed"));
    node.append(block("prose", one.text, one.cut));
    return node;
  }
  if (one.failed) {
    asked.node.classList.add("failed");
    asked.marks.replaceChildren(element("span", "tag failed", "failed"));
  }
  asked.output.replaceChildren(element("p", "label", one.failed ? "What went wrong" : "What came back"));
  if (one.text === "") asked.output.append(element("p", "pending", "Nothing."));
  else asked.output.append(block("code output", one.text, one.cut));
  return undefined;
}

function moment(one) {
  if (one.from === "tool") return call(one);
  if (one.from === "result") return answer(one);
  if (one.from === "thought") {
    const node = headed("thought", "thought", "Thinking", one.at);
    node.append(block("prose", one.text, one.cut));
    return node;
  }
  if (one.from === "note") {
    const node = headed("note", "warning", "Claude Code", one.at);
    node.append(block("prose", one.text, one.cut));
    return node;
  }
  if (one.from === "person") {
    const node = element("div", "moment person");
    const who = element("p", "who");
    who.append(element("span", null, "From the thread"), element("span", null, when(one.at)));
    node.append(who, block("prose", one.text, one.cut));
    return node;
  }
  const node = element("div", "moment agent");
  node.title = when(one.at);
  node.append(block("prose", one.text, one.cut));
  return node;
}

/** A subagent's work is gathered under one line, apart from the thread's, since it reaches the thread only through what the agent makes of it. */
function place(node, aside) {
  if (!aside) {
    log.append(node);
    return;
  }
  let group = log.lastElementChild;
  if (group === null || !group.classList.contains("aside")) {
    group = element("div", "aside");
    group.append(element("span", "tag", "subagent"));
    log.append(group);
  }
  group.append(node);
}

function describe(one) {
  const called = name(one);
  document.title = called;

  title.replaceChildren(element("span", "badge " + one.state, one.state));
  if (one.thread && one.thread.url) {
    const link = element("a", null, called);
    link.href = one.thread.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    title.append(link);
  } else {
    title.append(element("span", null, called));
  }

  const bits = [one.cwd, "session " + sessionId];
  if (one.model) bits.push(one.model + (one.effort ? ", " + one.effort + " effort" : ""));
  about.replaceChildren(...bits.map(function (bit) { return element("span", null, bit); }));
}

async function refresh() {
  let payload;
  try {
    payload = await (await fetch("/session.json?id=" + encodeURIComponent(sessionId) + "&from=" + from)).json();
  } catch (error) {
    sub.textContent = "Cannot reach the bot: " + error;
    return;
  }
  if (payload.conversation) describe(payload.conversation);
  if (payload.error) {
    sub.textContent = payload.error;
    return;
  }
  if (payload.missing) {
    sub.textContent = "Claude Code has not written anything down for this session yet.";
    return;
  }

  // Following only when already at the end, so reading back is not interrupted.
  const following = window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
  // A transcript read from its start again is one that was replaced, not added to.
  if (payload.from === 0) {
    log.replaceChildren();
    calls.clear();
    seen = 0;
  }
  for (const one of payload.moments) {
    const node = moment(one);
    if (node !== undefined) place(node, one.aside);
  }
  seen += payload.moments.length;
  from = payload.next;

  sub.textContent = seen === 0
    ? "Nothing in this session yet."
    : seen + (seen === 1 ? " thing" : " things") + " so far, refreshed every 2s.";
  if (following && payload.moments.length > 0) window.scrollTo(0, document.body.scrollHeight);
}

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>
`;
