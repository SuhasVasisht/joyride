// C6: artifact registry: register a local report (snapshot + sandboxed
// preview), link it to an idea, and hosted links that open
// natively. Runs only against the sandbox daemon (E2E_PORT).
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { shot } from "./shot";

const PORT = Number(process.env.E2E_PORT ?? 4399);
if (PORT === 4317 || PORT === 3000) throw new Error("artifacts e2e refuses to run against the real daemon port");
const BASE = `http://127.0.0.1:${PORT}`;
const FILES = `/tmp/joyride-e2e-${PORT}/files`;
const REPORT = path.join(FILES, "checkout-latency.html");

async function call<T = any>(method: string, p: string, body?: unknown): Promise<T> {
  const r = await fetch(BASE + p, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok && r.status !== 409) throw new Error(`${method} ${p} -> ${r.status}: ${t}`);
  return t ? JSON.parse(t) : (null as T);
}

const REPORT_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Checkout latency report</title>
<style>
body{margin:0;font:15px/1.55 Georgia,serif;color:#1d2433;background:#fff}
main{max-width:720px;margin:0 auto;padding:36px 32px}
h1{font:600 28px/1.2 -apple-system,Helvetica,sans-serif;margin:0 0 6px}
.sub{color:#68708a;font:13px -apple-system,Helvetica,sans-serif;margin-bottom:24px}
table{border-collapse:collapse;width:100%;font:13px -apple-system,Helvetica,sans-serif;margin:16px 0}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #e3e6ee}th{color:#68708a;font-weight:500}
.bar{height:10px;background:#3b6ea8;border-radius:2px}
.note{background:#f4f6fa;border-left:3px solid #3b6ea8;padding:10px 14px;font-size:14px}
</style></head><body><main>
<h1>Checkout latency report</h1>
<div class="sub">Week 39, production traffic, p95 over 1.2M checkouts</div>
<p>Checkout p95 fell from 1,840 ms to 610 ms after we moved cart totals to the server and cached tax rates per region. The biggest single win was removing the second price recalculation in the browser.</p>
<table><tr><th>Step</th><th>Before</th><th>After</th><th></th></tr>
<tr><td>Cart totals</td><td>720 ms</td><td>140 ms</td><td><div class="bar" style="width:20%"></div></td></tr>
<tr><td>Tax lookup</td><td>610 ms</td><td>90 ms</td><td><div class="bar" style="width:15%"></div></td></tr>
<tr><td>Payment intent</td><td>510 ms</td><td>380 ms</td><td><div class="bar" style="width:74%"></div></td></tr></table>
<p class="note">Decision: keep tax rates in a per-region cache with a 15 minute TTL. Rates change at most daily, and the cache removed 520 ms from p95.</p>
<p>Learning: the browser recalculated prices twice because the coupon widget re-rendered the cart. Guard expensive recalculation behind a memo keyed on cart version.</p>
<script>document.querySelector('.sub').dataset.ok = '1'</script>
</main></body></html>`;

async function seed() {
  fs.mkdirSync(FILES, { recursive: true });
  fs.writeFileSync(REPORT, REPORT_HTML);
  const ms = await call<any[]>("GET", "/api/missions");
  if (!ms.some((m) => m.id === "checkout-latency")) {
    await call("POST", "/api/missions", { id: "checkout-latency", title: "Cut checkout latency", repos: ["/tmp/joyride-fixture-repos/alpha"], goal: "Bring checkout p95 under 800 ms.", done_when: [{ text: "p95 under 800 ms on the load test", kind: "test" }] });
  }
  await call("POST", "/api/artifacts", { url: "https://github.com/acme/shop/pull/412", title: "Move cart totals to the server", mission: "checkout-latency" });
  await call("POST", "/api/artifacts", { url: "https://claude.ai/code/artifact/6a448de8-f24e-4fe1-a83a-26fd74b812b8", title: "Tax cache options compared", mission: "checkout-latency" });
  await call("POST", "/api/artifacts", { url: "https://chatgpt.com/share/68f0c2a1-9b7e-8000-a1b2-3c4d5e6f7a8b", title: "Coupon widget re-render investigation", created: new Date(Date.now() - 3 * 864e5).toISOString() });
}

test.describe.configure({ mode: "serial" });

test.afterAll(async () => { await call("PUT", "/api/missions/checkout-latency", { archive: true }); });

test("artifacts: register a local report, preview it sandboxed and show it on its idea", async ({ page }) => {
  await seed();

  await test.step("register through the form", async () => {
    // #/artifacts now redirects to the knowledge home, filtered to what got made.
    await page.goto("/#/artifacts");
    await expect(page).toHaveURL(/#\/knowledge\?types=reports/);
    await expect(page.getByTestId("knowledge-page")).toBeVisible();
    await expect(page.locator(".kn-groups").getByText("Move cart totals to the server")).toBeVisible();
    await page.getByRole("button", { name: "Register an artifact" }).click();
    const form = page.getByRole("form", { name: "Register an artifact" });
    await form.getByLabel("Link or file path").fill(REPORT);
    await form.getByLabel("Summary").fill("Checkout p95 improvements and cache choices.");
    await form.getByLabel("Idea").selectOption("checkout-latency");
    await form.getByRole("button", { name: "Register" }).click();
    await page.getByRole("button", { name: "Back to details" }).click();
    const detail = page.getByTestId("artifact-detail");
    await expect(detail.getByRole("heading", { name: "Checkout latency report" })).toBeVisible();
    await expect(detail.getByRole("button", { name: /Distill/ })).toHaveCount(0);
    await expect(detail.getByTestId("artifact-notes")).toContainText("Checkout p95 improvements and cache choices.");
    // The snapshot renders inside a sandboxed iframe (scripts on, same-origin off).
    const frame = page.getByTestId("artifact-preview");
    await expect(frame).toHaveAttribute("sandbox", /allow-scripts/);
    await expect(frame).not.toHaveAttribute("sandbox", /allow-same-origin/);
    await expect(page.frameLocator("[data-testid=artifact-preview]").getByRole("heading", { name: "Checkout latency report" })).toBeVisible();
    const list = await call<any[]>("GET", "/api/artifacts?mission=checkout-latency");
    const rep = list.find((a) => a.kind === "report")!;
    expect(rep.embeddable).toBe(true);
    expect(rep.snapshot_blob).toMatch(/^[a-f0-9]{64}$/);
    const pv = await fetch(`${BASE}/api/artifacts/${rep.id}/preview`);
    expect(pv.headers.get("content-security-policy")).toContain("sandbox");
    await page.waitForTimeout(300);
    await shot(page, "C6", "artifacts");
  });

  await test.step("hosted links open natively", async () => {
    await page.keyboard.press("Escape");
    await page.locator(".kn-groups").getByText("Tax cache options compared").first().click();
    await page.getByRole("button", { name: "Back to details" }).click();
    const detail = page.getByTestId("artifact-detail");
    await expect(detail.getByRole("heading", { name: "Tax cache options compared" })).toBeVisible();
    await expect(detail.locator("iframe")).toHaveCount(0);
    await expect(detail.getByRole("link", { name: "Open in Claude" }).first()).toHaveAttribute("href", /claude\.ai\/code\/artifact\//);
    await page.keyboard.press("Escape");
    await page.locator(".kn-groups").getByText("Move cart totals to the server").first().click();
    await expect(page.getByTestId("artifact-detail").getByRole("link", { name: "Open on GitHub" }).first()).toHaveAttribute("href", "https://github.com/acme/shop/pull/412");
    await shot(page, "C6", "artifact-hosted");
  });

  await test.step("kind filter and mission panel", async () => {
    await page.keyboard.press("Escape");
    await page.getByTestId("type-filter").getByRole("button", { name: /^Pull requests/ }).click();
    await expect(page.getByTestId("knowledge-row")).toHaveCount(1);
    await page.goto("/#/mission/checkout-latency");
    const panel = page.getByTestId("artifacts-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("link", { name: "Checkout latency report", exact: true })).toBeVisible();
    await expect(panel.getByText("Checkout p95 improvements and cache choices.")).toBeVisible();
    await panel.scrollIntoViewIfNeeded();
    await shot(page, "C6", "mission-artifact-link-cards");
    await panel.getByRole("link", { name: "Checkout latency report", exact: true }).click();
    await expect(page.getByTestId("artifact-reader")).toBeVisible();
    await page.getByRole("button", { name: "Back to details" }).click();
    await expect(page.getByTestId("artifact-detail").getByRole("heading", { name: "Checkout latency report" })).toBeVisible();
  });
});

test("artifacts: browse Joyride and Claude cards newest first", async ({ page, request }) => {
  const file = path.join(FILES, "latest-report.md");
  fs.writeFileSync(file, "# Latest review report\n\nThe latest report stays readable.\n");
  const latest = await call<any>("POST", "/api/artifacts", { local_source: file, title: "Latest review report", summary: "The newest report from Joyride.", mission: "checkout-latency" });
  await page.goto("/#/knowledge/artifacts");
  const view = page.getByTestId("artifacts-review");
  await expect(view).toBeVisible();
  await expect(view.getByTestId("artifact-row").first()).toHaveAttribute("data-id", latest.id);
  await expect(view.getByTestId("artifact-source-filter").getByRole("button", { name: /Claude artifact/ })).toBeVisible();
  await expect(view.getByTestId("artifact-source-filter").getByRole("button", { name: /Joyride report/ })).toBeVisible();
  await view.getByTestId("artifact-row").first().getByRole("button").click();
  await expect(page.getByTestId("artifact-reader")).toContainText("The latest report stays readable.");
  await page.getByRole("button", { name: "Back to details" }).click();
  await expect(page.getByTestId("artifact-detail").getByTestId("artifact-report")).toContainText("The latest report stays readable.");
  await expect(page.getByRole("button", { name: /Mark reviewed|Mark unreviewed|Distill/ })).toHaveCount(0);
  await shot(page, "C6", "artifact-link-card-review");
  for (const suffix of ["distill", "distilled"]) expect((await request.post(`/api/artifacts/${latest.id}/${suffix}`)).status()).toBe(404);
});
