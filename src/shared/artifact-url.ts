const TRAIL = /[)\].,;:!?'"`>}*_]+$/;

/** Canonical form used for dedupe: no query, hash or trailing punctuation; PRs without /files, /diff, ... */
export function normalizeUrl(raw: string): string {
  let u = raw.trim().replace(TRAIL, "");
  try {
    const p = new URL(u);
    p.hash = ""; p.search = "";
    if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(p.hostname)) p.protocol = "https:";
    p.hostname = p.hostname.toLowerCase().replace(/^www\./, "");
    if (p.hostname === "chat.openai.com") p.hostname = "chatgpt.com";
    let m = p.pathname.match(/^(\/[\w.-]+\/[\w.-]+\/pull\/\d+)/);
    if (p.hostname === "github.com" && m) p.pathname = m[1];
    m = p.pathname.match(/^(\/[\w.-]+\/[\w.-]+\/pull-requests\/\d+)/);
    if (p.hostname === "bitbucket.org" && m) p.pathname = m[1];
    u = p.toString().replace(/\/$/, "");
  } catch { /* leave as typed */ }
  return u;
}

