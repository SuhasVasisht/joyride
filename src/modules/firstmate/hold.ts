// Captain-hold reasons (vendor/firstmate/bin/fm-hold-reason-lib.sh). tasks-axi keeps a
// hold reason inside a parenthesised backlog tag, so fm-captain-hold.sh stores prose as
// `fm-hold-v1:<base64 of UTF-8>`; anything unmarked is plain text.

/** The text an `fm-hold-v1:<base64>` hold carries, else the hold as written. A payload that is not
 * canonical base64 of valid UTF-8 keeps its stored text, as the library does. */
export function decodeHold(hold: string | null | undefined): string | null {
  if (!hold) return null;
  const m = hold.match(/^fm-hold-v1:(.*)$/s);
  if (!m) return hold.trim() || null;
  const payload = m[1].trim();
  const bytes = Buffer.from(payload, "base64");
  if (bytes.toString("base64") !== payload) return hold.trim() || null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim() || null; }
  catch { return hold.trim() || null; }
}
