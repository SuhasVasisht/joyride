// Pure, dependency-free helpers shared by the joyride-evidence CLI (bun) and
// the daemon: tool-input decoding, test-command detection and test-runner
// summary parsing. Node builtins only; keep it that way.

export type Assertions = { passed: number; failed: number; skipped: number };
export type Outcome = "pass" | "fail" | "unknown";

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "").replace(/\r(?!\n)/g, "\n");

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function shellish(argv: unknown[]): string {
  const a = argv.map(String);
  if (a.length >= 3 && /(^|\/)(ba|z|da)?sh$/.test(a[0]) && /^-l?c$/.test(a[1])) return a.slice(2).join(" ");
  return a.join(" ");
}

/** The shell command inside a hook tool input. Hook inputs may be objects or a clipped JSON string. */
export function commandOf(input: unknown): string {
  if (input == null) return "";
  if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    const c = o.command ?? o.cmd;
    if (Array.isArray(c)) return shellish(c);
    return typeof c === "string" ? c : "";
  }
  const s = String(input);
  try { const parsed = JSON.parse(s); if (parsed && typeof parsed === "object") return commandOf(parsed); } catch { /* clipped */ }
  const m = s.match(/"(?:command|cmd)"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (m) { try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; } }
  const arr = s.match(/"(?:command|cmd)"\s*:\s*\[((?:"(?:[^"\\]|\\.)*",?\s*)*)/);
  if (arr) {
    const items = [...arr[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => { try { return JSON.parse(`"${x[1]}"`); } catch { return x[1]; } });
    if (items.length) return shellish(items);
  }
  return "";
}

/** File paths an edit tool touches (Claude Edit/Write/MultiEdit/NotebookEdit, Codex apply_patch). */
export function editedPaths(input: unknown, cwd?: string | null): string[] {
  const out = new Set<string>();
  const add = (p: string) => {
    if (!p) return;
    const abs = p.startsWith("/") || !cwd ? p : `${cwd.replace(/\/$/, "")}/${p.replace(/^\.\//, "")}`;
    out.add(abs);
  };
  let text = "";
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const k of ["file_path", "notebook_path", "path"]) if (typeof o[k] === "string") add(o[k] as string);
    text = JSON.stringify(input);
  } else if (typeof input === "string") {
    text = input;
    try { const parsed = JSON.parse(input); if (parsed && typeof parsed === "object") return editedPaths(parsed, cwd); } catch { /* clipped */ }
    const m = input.match(/"(?:file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) { try { add(JSON.parse(`"${m[1]}"`)); } catch { add(m[1]); } }
  }
  for (const m of text.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\n\\"]+)/g)) add(m[1].trim());
  return [...out];
}

// ---------- test commands (inferred evidence) ----------
const TEST_CMD = new RegExp(
  "(?:^|[\\s;&|(])(" + [
    "(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?(?:test|e2e|test:[\\w:-]+)(?![\\w-])",
    "npx\\s+(?:vitest|jest|mocha|playwright\\s+test)",
    "vitest(?:\\s+run)?(?![\\w-])",
    "jest(?![\\w-])",
    "(?:python3?\\s+-m\\s+)?pytest(?![\\w-])",
    "playwright\\s+test",
    "go\\s+test(?![\\w-])",
    "cargo\\s+(?:test|nextest)(?![\\w-])",
    "bun\\s+test(?![\\w-])",
    "make\\s+(?:test|check)(?![\\w-])",
    "mvn\\s+(?:test|verify)(?![\\w-])",
    "\\.?/?gradlew?\\s+test(?![\\w-])",
    "rspec(?![\\w-])",
    "tox(?![\\w-])",
    "deno\\s+test(?![\\w-])",
    "dotnet\\s+test(?![\\w-])",
  ].join("|") + ")",
);

/** If `cmd` runs a test suite, a short name for it ("npm test", "pytest"); else null. */
export function testCommandName(cmd: string): string | null {
  if (!cmd || /joyride-evidence/.test(cmd)) return null;
  const m = cmd.match(TEST_CMD);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

// ---------- test-runner summaries ----------
function countParts(line: string): Assertions | null {
  const a: Assertions = { passed: 0, failed: 0, skipped: 0 };
  let hit = false;
  for (const m of line.matchAll(/(\d+)\s+(passed|passing|xpassed|flaky|failed|failing|errors?|skipped|todo|pending|ignored|xfailed|deselected)\b/gi)) {
    const n = Number(m[1]);
    const k = m[2].toLowerCase();
    hit = true;
    if (/^(passed|passing|xpassed|flaky)$/.test(k)) a.passed += n;
    else if (/^(failed|failing|errors?)$/.test(k)) a.failed += n;
    else a.skipped += n;
  }
  return hit ? a : null;
}
const lastMatch = (text: string, re: RegExp) => { let last: RegExpMatchArray | null = null; for (const m of text.matchAll(re)) last = m; return last; };

/** Parse the summary line of common runners (vitest, jest, pytest, cargo, playwright, mocha, go). */
export function parseTestSummary(raw: string): Assertions | null {
  if (!raw) return null;
  const text = stripAnsi(raw);
  // jest: "Tests:       1 failed, 10 passed, 11 total"
  let m = lastMatch(text, /^\s*Tests:\s+(.+)$/gm);
  if (m) { const a = countParts(m[1]); if (a) return a; }
  // vitest: " Tests  12 passed | 1 failed (13)"
  m = lastMatch(text, /^\s*Tests\s{2,}(\d.+)$/gm);
  if (m) { const a = countParts(m[1]); if (a) return a; }
  // pytest: "==== 3 failed, 10 passed, 1 skipped in 0.12s ===="
  m = lastMatch(text, /^=+ (.*\d+ (?:passed|failed|skipped|errors?|xfailed|xpassed|deselected).*?) in [\d.]+s(?: \([^)]*\))? =+\s*$/gm);
  if (m) { const a = countParts(m[1]); if (a) return a; }
  // cargo: "test result: ok. 5 passed; 0 failed; 1 ignored; ..."
  const cargo = [...text.matchAll(/^test result: \w+\. (.+)$/gm)];
  if (cargo.length) {
    const a: Assertions = { passed: 0, failed: 0, skipped: 0 };
    for (const c of cargo) { const p = countParts(c[1]); if (p) { a.passed += p.passed; a.failed += p.failed; a.skipped += p.skipped; } }
    return a;
  }
  // playwright list/line reporter: trailing "  5 passed (3.2s)", "  1 failed", "  2 skipped", "  1 flaky"
  const pw = [...text.matchAll(/^\s{1,4}(\d+) (passed|failed|skipped|flaky|did not run|interrupted)(?: \([\d.]+m?s\))?\s*$/gm)];
  if (pw.length) {
    const a: Assertions = { passed: 0, failed: 0, skipped: 0 };
    for (const p of pw) {
      const n = Number(p[1]);
      if (p[2] === "passed" || p[2] === "flaky") a.passed += n;
      else if (p[2] === "failed" || p[2] === "interrupted") a.failed += n;
      else a.skipped += n;
    }
    return a;
  }
  // mocha: "  12 passing (2s)" / "  1 failing" / "  2 pending"
  const mocha = [...text.matchAll(/^\s+(\d+) (passing|failing|pending)\b/gm)];
  if (mocha.length) return countParts(mocha.map((x) => `${x[1]} ${x[2]}`).join(" "));
  // go: per-test lines, else per-package lines
  const goTests = [...text.matchAll(/^\s*--- (PASS|FAIL|SKIP):/gm)];
  if (goTests.length) {
    const a: Assertions = { passed: 0, failed: 0, skipped: 0 };
    for (const g of goTests) { if (g[1] === "PASS") a.passed++; else if (g[1] === "FAIL") a.failed++; else a.skipped++; }
    return a;
  }
  const goPkgs = [...text.matchAll(/^(ok|FAIL)\s+\S+\s+(?:[\d.]+s|\(cached\))/gm)];
  if (goPkgs.length) return { passed: goPkgs.filter((g) => g[1] === "ok").length, failed: goPkgs.filter((g) => g[1] === "FAIL").length, skipped: 0 };
  return null;
}

/** Playwright JSON reporter output → assertion counts. */
export function parsePlaywrightJson(j: any): Assertions | null {
  const s = j?.stats;
  if (!s || typeof s !== "object" || !("expected" in s || "unexpected" in s)) return null;
  return { passed: Number(s.expected ?? 0) + Number(s.flaky ?? 0), failed: Number(s.unexpected ?? 0), skipped: Number(s.skipped ?? 0) };
}

/** Deterministic outcome of one evidence record: tests and exit codes decide. */
export function outcomeOf(exit: number | null | undefined, a: Assertions | null | undefined): Outcome {
  if (a && a.failed > 0) return "fail";
  if (exit != null && exit !== 0) return "fail";
  if (exit === 0) return "pass";
  if (a && a.passed > 0) return "pass";
  return "unknown";
}

/** Last `n` characters of a log, ANSI stripped. */
export function tailOf(text: string, n = 4096) {
  const t = stripAnsi(text);
  return t.length > n ? t.slice(t.length - n) : t;
}
export { clip };
