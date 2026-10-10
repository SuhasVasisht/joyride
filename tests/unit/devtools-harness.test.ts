import { describe, it, expect } from "vitest";
import { freePort, pageId } from "../e2e/devtools";
import net from "node:net";

describe("DevTools worker targeting", () => {
  it("selects the exact URL including commas rather than the displayed selected tab", () => {
    expect(pageId("pages[2]{id,url,selected}:\n  7,http://localhost/#/map?a=1,b=2,false\n  1,about:blank,true", "http://localhost/#/map?a=1,b=2")).toBe("7");
  });
  it("refuses missing and ambiguous pages", () => {
    expect(() => pageId("  1,about:blank,true", "http://localhost")).toThrow("found 0");
    expect(() => pageId("  1,about:blank,true\n  2,about:blank,false", "about:blank")).toThrow("found 2");
  });
  it("allocates a port without sharing an occupied listener", async () => {
    const first = net.createServer();
    await new Promise<void>(resolve => first.listen(0, "127.0.0.1", resolve));
    try {
      const address = first.address();
      if (!address || typeof address === "string") throw new Error("Missing listener");
      expect(await freePort()).not.toBe(address.port);
    } finally { await new Promise<void>(resolve => first.close(() => resolve())); }
  });
});
