/**
 * The whole replies that count as approval. Matched as the entire message rather
 * than as a substring, so "don't do it" is a refusal and not an approval that
 * happens to contain one.
 */
const APPROVALS: ReadonlySet<string> = new Set([
  "approve",
  "approved",
  "allow",
  "allowed",
  "yes",
  "y",
  "ok",
  "okay",
  "lgtm",
  "sure",
  "go ahead",
  "do it",
  "proceed",
  "yep",
  "yeah",
  "👍",
]);

/** Whether a person's reply to a parked permission request means "go ahead". */
export function isApproval(reply: string): boolean {
  const normalized = reply
    .trim()
    .toLowerCase()
    .replace(/[.!,;:]+$/, "")
    .replace(/\s+/g, " ");
  return APPROVALS.has(normalized);
}
