import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { asOneLine, threadStartedAt } from "../src/conversation.ts";

describe("what the web view is told a thread is", () => {
  it("puts what was asked on one line", () => {
    strictEqual(asOneLine("  fix the flaky test\n\nand say what it was  "), "fix the flaky test and say what it was");
  });

  it("says nothing for a mention that had no words of its own", () => {
    strictEqual(asOneLine("   \n  "), "");
  });

  it("cuts a long ask short rather than handing a list a paragraph", () => {
    const asked = asOneLine("x".repeat(400));
    strictEqual(asked.length, 201);
    strictEqual(asked.endsWith("x…"), true);
  });

  it("leaves an ask that already fits alone", () => {
    const asked = "x".repeat(200);
    strictEqual(asOneLine(asked), asked);
  });

  it("reads the moment a slack thread started out of its key", () => {
    strictEqual(threadStartedAt("slack:T013TNLECSD:C0BSLL9GU4E:1790706779.993569"), "2026-09-29T18:32:59.993Z");
  });

  it("has nothing to say for a key that does not name a moment", () => {
    for (const key of [
      // A slack bot configured to answer a channel rather than a thread.
      "slack:T013TNLECSD:C0BSLL9GU4E",
      "slack:T013TNLECSD:C0BSLL9GU4E:nonsense",
      "github:acme/widgets#7",
      "linear:9f2c1e40-6b7a-4d02-9a11-5c8e2f0b3d64",
      "",
    ]) {
      strictEqual(threadStartedAt(key), undefined, `${key} was read as a moment`);
    }
  });
});
