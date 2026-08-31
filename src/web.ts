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
  ol { gap: .6rem; }
  .moment {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: .7rem .85rem;
  }
  .moment.aside { border-style: dashed; }
  .who { margin: 0 0 .4rem; display: flex; align-items: baseline; gap: .5rem; flex-wrap: wrap; font-size: .8rem; }
  .name { font-weight: 600; }
  .person .name { color: var(--link); }
  .tool .name, .result .name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .thought .name, .result .name { color: var(--dim); }
  .note .name { color: var(--waiting); }
  .when { color: var(--dim); }
  .tag { color: var(--dim); border: 1px solid var(--line); border-radius: 999px; padding: 0 .4rem; font-size: .7rem; }
  .tag.failed { color: var(--waiting); }
  pre.text {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: .82rem;
    line-height: 1.45;
  }
  .person pre.text, .agent pre.text, .thought pre.text { font-family: inherit; font-size: .92rem; }
  pre.folded {
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
  <ol id="log"></ol>
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

/** A result is not told the name of the call it answers, so the calls already on the page are asked. */
const names = new Map();

let from = 0;

const LABELS = { person: "From the thread", agent: "The agent", thought: "Thinking", note: "Claude Code" };

function label(one) {
  if (one.from === "tool") return one.tool || "a tool";
  if (one.from === "result") return "↳ " + (names.get(one.useId) || "what came back");
  return LABELS[one.from] || one.from;
}

function when(at) {
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleTimeString() : "";
}

function moment(one) {
  if (one.from === "tool") names.set(one.useId, one.tool);

  const item = element("li", "moment " + one.from + (one.aside ? " aside" : ""));

  const who = element("p", "who");
  who.append(element("span", "name", label(one)));
  if (one.aside) who.append(element("span", "tag", "subagent"));
  if (one.failed) who.append(element("span", "tag failed", "failed"));
  const at = when(one.at);
  if (at) who.append(element("span", "when", at));
  item.append(who);

  const text = element("pre", "text", one.text);
  item.append(text);
  if (one.text.length > FOLD_CHARS) {
    text.classList.add("folded");
    const more = element("button", "more", "Show all");
    more.addEventListener("click", function () {
      text.classList.remove("folded");
      more.remove();
    });
    item.append(more);
  }
  if (one.cut) item.append(element("p", "cut", one.cut.toLocaleString() + " more characters were not kept."));

  return item;
}

function describe(one) {
  const name = (one.thread && one.thread.title) || one.conversationKey || "a session";
  document.title = name;

  title.replaceChildren(element("span", "badge " + one.state, one.state));
  if (one.thread && one.thread.url) {
    const link = element("a", null, name);
    link.href = one.thread.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    title.append(link);
  } else {
    title.append(element("span", null, name));
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
    names.clear();
  }
  for (const one of payload.moments) log.append(moment(one));
  from = payload.next;

  const count = log.children.length;
  sub.textContent = count === 0
    ? "Nothing in this session yet."
    : count + (count === 1 ? " thing" : " things") + " so far, refreshed every 2s.";
  if (following && payload.moments.length > 0) window.scrollTo(0, document.body.scrollHeight);
}

refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>
`;
