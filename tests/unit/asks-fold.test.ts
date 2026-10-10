// Parity: Joyride's TypeScript port of Firstmate's status-decision fold
// (src/modules/firstmate/fold.ts) against the vendored library itself
// (vendor/firstmate/bin/fm-classify-lib.sh, status_open_decisions), on the same fixtures.
// Each fixture is written to a status file; bash sources the library read-only and folds it.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { paths } from "../../src/shared/paths.ts";
import { foldOpenDecisions, formatOpenDecisions, statusKind, type FoldKind } from "../../src/modules/firstmate/fold.ts";

const LIB = path.join(paths.firstmateDir, "bin", "fm-classify-lib.sh");
const T = 1790000000;

type Case = { name: string; text: string; kind?: FoldKind | ""; meta?: string | null };
const CASES: Case[] = [
  { name: "keyed-open", text: `needs-decision [key=api-shape] [at=${T}]: pick the response shape\n` },
  { name: "keyed-open-then-working", text: `needs-decision [key=flake-cause] [at=${T}]: two causes; pick one\nworking [at=${T + 60}]: still reading logs\n` },
  { name: "keyed-resolved", text: `needs-decision [key=k1]: a\nworking: b\nresolved [key=k1]: answered: go with A\n` },
  { name: "resolved-other-key", text: `needs-decision [key=k1]: a\nresolved [key=k2]: unrelated\n` },
  { name: "unkeyed-default", text: "working: starting\nneeds-decision: which db?\nworking: waiting\n" },
  { name: "bare-resolved-closes-default", text: "needs-decision: which db?\nresolved: sqlite\n" },
  { name: "note-head-key", text: "needs-decision: [key=texte] pick the wall text\n" },
  { name: "note-head-key-resolved", text: "needs-decision: [key=texte] pick\nresolved [key=texte]: done\n" },
  { name: "both-positions", text: "needs-decision [key=a]: [key=b] note keeps b token\n" },
  { name: "key-deep-in-note-is-prose", text: "needs-decision: the [key=x] token is prose\n" },
  { name: "bad-slug-skipped", text: "needs-decision [key=bad slug!]: nope\nneeds-decision [key=ok]: yes\n" },
  { name: "reopen-moves-last", text: "needs-decision [key=a]: first\nblocked [key=b]: second\nneeds-decision [key=a]: again\n" },
  { name: "blocked-keyed", text: "blocked [key=creds] [at=1790000100]: need the API key\npaused: waiting\n" },
  { name: "captain-held-closes", text: "needs-decision [key=scope]: ship or scout?\ncaptain-held [key=scope]: moved to backlog hold jr-scope\n" },
  { name: "done-clears-ship", kind: "ship", text: "needs-decision [key=a]: x\nblocked [key=b]: y\ndone: shipped\n" },
  { name: "done-clears-scout", kind: "scout", text: "needs-decision [key=a]: x\ndone: reported\n" },
  { name: "failed-clears-ship", kind: "ship", text: "needs-decision [key=a]: x\nfailed: gave up\nneeds-decision [key=c]: after\n" },
  { name: "done-keeps-secondmate", kind: "secondmate", text: "needs-decision [key=a]: x\ndone: other work\n" },
  { name: "done-keeps-unknown", kind: "unknown", text: "needs-decision [key=a]: x\ndone: finished\n" },
  { name: "readable-stamp-colon", text: "needs-decision [at=10:30] [key=t]: stamped with colons\n" },
  { name: "stamp-only-head", text: "blocked [at=10:30]: hm\n" },
  { name: "stamp-first", text: "needs-decision [at=1790000000] [key=first]: stamp before key\n" },
  { name: "corr-token", text: "needs-decision corr=0123456789abcdef [key=texte-du-mur]: pick\n" },
  { name: "corr-token-resolved", text: "needs-decision corr=0123456789abcdef [key=k]: pick\nresolved corr=fedcba9876543210 [key=k]: done\n" },
  { name: "corr-two-tokens", text: "needs-decision corr=0123456789abcdef corr=0123456789ABCDEF [key=k]: twice\n" },
  { name: "corr-bad-token", text: "needs-decision corr=xyz [key=k]: malformed token stays\n" },
  { name: "corr-token-first", text: "corr=0123456789abcdef needs-decision [key=k]: token first\n" },
  { name: "reserved-key-wrong-vocab", text: "needs-decision [key=pending-reply-42]: unrelated claim\n" },
  { name: "reserved-key-own-vocab", text: "needs-decision [key=pending-reply-42]: pending-reply-missed: no reply yet\nresolved [key=pending-reply-42]: bare close ignored\n" },
  { name: "reserved-key-own-close", text: "needs-decision [key=pending-reply-7]: pending-reply-missed: x\nresolved [key=pending-reply-7]: pending-reply-closed: replied\n" },
  { name: "colonless-key", text: "needs-decision [key=nocolon] still opens\n" },
  { name: "colonless-no-key", text: "needs-decision without a colon\n" },
  { name: "continuation-prose", text: "needs-decision [key=a]: line one\n  more prose: resolved [key=a]: not a line start\nresolved is a word here\n" },
  { name: "other-verbs-ignored", text: "note [key=a]: fyi\nworking [key=a]: wip\npaused [key=a]: wait\n" },
  { name: "blank-and-no-trailing-newline", text: "\n\nneeds-decision [key=a]: x\n\nblocked [key=b]: y" },
  { name: "tabs-in-note", text: "needs-decision [key=t]: a\tb\n" },
  { name: "empty", text: "" },
  { name: "meta-kind-ship", kind: "", meta: "branch=x\nkind=ship\n", text: "needs-decision [key=a]: x\ndone: shipped\n" },
  { name: "meta-kind-last-wins", kind: "", meta: "kind=ship\nkind=secondmate\n", text: "needs-decision [key=a]: x\ndone: shipped\n" },
  { name: "meta-no-kind-defaults-ship", kind: "", meta: "branch=x\n", text: "needs-decision [key=a]: x\ndone: shipped\n" },
  { name: "meta-missing-unknown", kind: "", meta: null, text: "needs-decision [key=a]: x\ndone: shipped\n" },
  { name: "meta-odd-kind", kind: "", meta: "kind=captain\n", text: "needs-decision [key=a]: x\nfailed: y\n" },
];

const haveLib = fs.existsSync(LIB);
let dir = "";
let bashOut: Record<string, string> = {};

beforeAll(() => {
  if (!haveLib) return;
  dir = fs.mkdtempSync(path.join(process.env.JOYRIDE_RUNTIME!, "fold-"));
  for (const c of CASES) {
    fs.writeFileSync(path.join(dir, `${c.name}.status`), c.text);
    if (c.meta != null) fs.writeFileSync(path.join(dir, `${c.name}.meta`), c.meta);
  }
  // One bash run folds every fixture, separated by a marker line.
  const script = `. "$1"; shift; for c in "$@"; do n=\${c%%=*}; k=\${c#*=}; printf '@@%s\\n' "$n"; status_open_decisions "$DIR/$n.status" "$k"; printf '\\n'; done`;
  const args = CASES.map((c) => `${c.name}=${c.kind ?? "ship"}`);
  const out = execFileSync("bash", ["-c", script, "fold", LIB, ...args], { encoding: "utf8", env: { ...process.env, DIR: dir }, timeout: 60_000 });
  for (const block of out.split(/^@@/m).slice(1)) {
    const nl = block.indexOf("\n");
    bashOut[block.slice(0, nl)] = block.slice(nl + 1).replace(/\n+$/, "");
  }
});

describe.skipIf(!haveLib)(`status fold parity with ${LIB}${haveLib ? "" : " (skipped: needs vendor/firstmate)"}`, () => {
  it("the library really folded every fixture (no empty-equals-empty pass)", () => {
    expect(Object.keys(bashOut).sort()).toEqual(CASES.map((c) => c.name).sort());
    expect(Object.values(bashOut).filter(Boolean).length).toBeGreaterThanOrEqual(25);
    expect(bashOut["keyed-open-then-working"]).toBe("flake-cause\tneeds-decision\ttwo causes; pick one");
  });
  it.each(CASES.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const kind: FoldKind = c.kind === "" ? statusKind(c.meta ?? null) : (c.kind ?? "ship");
    expect(formatOpenDecisions(foldOpenDecisions(c.text, kind))).toBe(bashOut[c.name]);
  });
});

describe("status fold extras", () => {
  it("knows whether a key was stated, when the opener was stamped, and which line opened it", () => {
    const open = foldOpenDecisions(`working: a\nneeds-decision [key=k] [at=${T}]: pick\nneeds-decision: unkeyed\n`, "ship");
    expect(open).toEqual([
      { key: "k", verb: "needs-decision", note: "pick", at: new Date(T * 1000).toISOString(), keyed: true, line: 1 },
      { key: "default", verb: "needs-decision", note: "unkeyed", at: null, keyed: false, line: 2 },
    ]);
  });
  it("reads the task kind the terminal rule needs from the meta", () => {
    expect(statusKind(null)).toBe("unknown");
    expect(statusKind("branch=x\n")).toBe("ship");
    expect(statusKind("kind=scout\n")).toBe("scout");
    expect(statusKind("kind=captain\n")).toBe("unknown");
  });
});
