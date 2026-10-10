import { test, expect } from "@playwright/test";
import { seedWorld, raise, W, call } from "./map-seed";
import { shot } from "./shot";

test("the shared shell publishes needs-you changes only when a native host exists", async ({ page }) => {
  await seedWorld();
  const item = await raise({ level: "L3", kind: "question", title: "Native notification fixture", why: "Choose the export format.", worker: W.working, session: "claude:11111111-1111-4111-8111-111111111111" });
  await page.addInitScript(() => {
    const messages: unknown[] = [];
    Object.defineProperty(window, "nativeMessages", { value: messages });
    window.joyrideNative = { postMessage: (message) => messages.push(message) };
  });
  await page.goto("/");
  const messages = () => page.evaluate(() => Reflect.get(window, "nativeMessages"));
  await expect.poll(messages).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "needs-you", items: expect.arrayContaining([
      expect.objectContaining({ title: "Native notification fixture", route: `/worker/${encodeURIComponent(W.working)}`, level: "L3" }),
    ]) }),
  ]));
  await page.keyboard.press("Meta+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await shot(page, "mac", "shared-ui-native-bridge");
  await call("POST", `/api/attention/${item.id}/label`, { label: "ack" });
  await expect.poll(async () => {
    const list: unknown = await messages();
    if (!Array.isArray(list)) return false;
    const last = list.at(-1);
    return last && typeof last === "object" && "items" in last && Array.isArray(last.items) && !last.items.some((i: { title: string }) => i.title === "Native notification fixture");
  }).toBe(true);
});
