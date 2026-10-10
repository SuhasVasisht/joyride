import { test, expect } from "./devtools";
import { shot } from "./shot";

test("DevTools reselects the exact page after a bridge restart and a competing tab", async ({ page, context, devtools }) => {
  test.setTimeout(240000);
  await page.goto("/#/map");
  const other = await context.newPage();
  await other.goto("about:blank");
  await devtools.select(other);
  const code = "() => location.href";
  const before = await devtools.command(page, "eval", "--full", code);
  expect(before).toContain(page.url());
  await devtools.raw("stop");
  const after = await devtools.command(page, "eval", "--full", code);
  expect(after).toContain(page.url());
  expect(other.url()).toBe("about:blank");
  await shot(page, "C12/devtools", "reconnected-page");
});
