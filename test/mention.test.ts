import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { createLogger } from "../src/logger.ts";
import { type Mention, readMentions, toMention } from "../src/mention.ts";

const log = createLogger("error");

function stream(text: string): NodeJS.ReadableStream {
  return Readable.from([text]);
}

async function collect(text: string): Promise<Mention[]> {
  const seen: Mention[] = [];
  for await (const mention of readMentions(stream(text), log)) seen.push(mention);
  return seen;
}

const minimal = { id: "a1", conversationKey: "github:acme#7", replyFile: "/tmp/a1.md" };

describe("reading mentions off stdin", () => {
  it("takes one compact object per line, the per-conversation shape", async () => {
    const seen = await collect(`${JSON.stringify({ ...minimal, prompt: "one" })}\n${JSON.stringify({ ...minimal, id: "a2", prompt: "two" })}\n`);
    deepStrictEqual(
      seen.map((one) => one.prompt),
      ["one", "two"],
    );
  });

  it("takes one pretty-printed object, the per-mention shape", async () => {
    const seen = await collect(`${JSON.stringify({ ...minimal, prompt: "one" }, null, 2)}\n`);
    strictEqual(seen.length, 1);
    strictEqual(seen[0]?.prompt, "one");
  });

  it("skips a line that is not a mention and keeps going", async () => {
    const seen = await collect(`not json\n${JSON.stringify(minimal)}\n`);
    strictEqual(seen.length, 1);
  });

  it("skips an object missing a field it cannot work without", async () => {
    const seen = await collect(`${JSON.stringify({ id: "a1" })}\n${JSON.stringify(minimal)}\n`);
    strictEqual(seen.length, 1);
    strictEqual(seen[0]?.id, "a1");
  });

  it("fills in the optional fields it was not given", () => {
    const mention = toMention(minimal);
    strictEqual(mention.platform, "");
    strictEqual(mention.title, "");
    strictEqual(mention.prompt, "");
  });

  it("refuses anything that is not an object", () => {
    throws(() => toMention([1, 2]), /not a JSON object/);
    throws(() => toMention(null), /not a JSON object/);
    throws(() => toMention({ ...minimal, replyFile: "" }), /has no "replyFile"/);
  });
});
