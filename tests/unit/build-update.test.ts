// The stale tab guard's decision: reload when idle, offer the control when something is in flight,
// never loop when a reload lands on the old bundle again. Plus the build id the daemon serves.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decideBuild } from "../../src/ui/lib/build.ts";
import { stampBuild, uiBuild } from "../../src/server/build.ts";

describe("decideBuild", () => {
  const base = { own: "aaa", served: "bbb", reloadedFor: null, busy: false };
  it("does nothing when the tab runs the served build", () => {
    expect(decideBuild({ ...base, served: "aaa" })).toBe("none");
  });
  it("does nothing without a build on either side (dev server, UI not built, daemon down)", () => {
    expect(decideBuild({ ...base, own: null })).toBe("none");
    expect(decideBuild({ ...base, served: null })).toBe("none");
  });
  it("reloads when idle", () => {
    expect(decideBuild(base)).toBe("reload");
  });
  it("offers the control when something is in flight", () => {
    expect(decideBuild({ ...base, busy: true })).toBe("offer");
  });
  it("never reloads twice for the same build", () => {
    expect(decideBuild({ ...base, reloadedFor: "bbb" })).toBe("offer");
  });
  it("reloads again for a later build", () => {
    expect(decideBuild({ ...base, reloadedFor: "bbb", served: "ccc" })).toBe("reload");
  });
});

describe("uiBuild", () => {
  it("changes with index.html and is null when the UI is not built", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jr-build-"));
    expect(uiBuild(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, "index.html"), "<html><head></head></html>");
    const a = uiBuild(dir);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(uiBuild(dir)).toBe(a);
    fs.writeFileSync(path.join(dir, "index.html"), "<html><head></head><!-- rebuilt --></html>");
    expect(uiBuild(dir)).not.toBe(a);
    expect(stampBuild("<html><head></head></html>", "abc")).toContain('<meta name="joyride-build" content="abc" />');
    expect(stampBuild("<html><head></head></html>", null)).not.toContain("joyride-build");
  });
});
