import { describe, it, expect } from "vitest";
import { createDraftStore, draftKey, DRAFT_TTL } from "../../src/ui/lib/drafts";

class BrowserStorage implements Storage {
  private data = new Map<string, string>();
  get length() { return this.data.size; }
  clear() { this.data.clear(); }
  getItem(key: string) { return this.data.get(key) ?? null; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string) { this.data.delete(key); }
  setItem(key: string, value: string) { this.data.set(key, value); }
}
const session = draftKey({ kind: "session", id: "claude:one" });

describe("browser chat drafts", () => {
  it("keys each target independently, including the same id in different boxes", () => {
    const storage = new BrowserStorage();
    const store = createDraftStore(() => storage);
    for (const kind of ["session", "ask", "composer", "task", "prompt"] as const) {
      store.update(draftKey({ kind, id: "one" }), { text: kind });
    }
    const restored = createDraftStore(() => storage);
    expect(restored.read(draftKey({ kind: "session", id: "one" })).text).toBe("session");
    expect(restored.read(draftKey({ kind: "ask", id: "one" })).text).toBe("ask");
    expect(restored.read(draftKey({ kind: "composer", id: "one" })).text).toBe("composer");
    expect(restored.read(session).text).toBe("");
  });

  it("restores image references and preserves them while editing text", () => {
    const storage = new BrowserStorage();
    const store = createDraftStore(() => storage);
    const images = [{ key: "image1", path: "/uploads/image.png", url: "/api/uploads/image.png", name: "image.png", bytes: 12 }];
    store.update(session, { images });
    store.update(session, { text: "Keep this screenshot" });
    const restored = createDraftStore(() => storage);
    expect(restored.read(session)).toMatchObject({ text: "Keep this screenshot", images });
  });

  it("expires abandoned drafts after seven days without extending expiry on reads", () => {
    const storage = new BrowserStorage();
    let now = 1000;
    const store = createDraftStore(() => storage, () => now);
    store.update(session, { text: "A deleted session's draft" });
    now += DRAFT_TTL - 1;
    expect(store.read(session).text).toBe("A deleted session's draft");
    now++;
    store.prune();
    expect(store.read(session).text).toBe("");
    expect(storage.getItem(session)).toBeNull();
    expect(createDraftStore(() => storage).read(session).text).toBe("");
  });

  it("clears a sent draft and lets the user clear an empty box", () => {
    const storage = new BrowserStorage();
    const store = createDraftStore(() => storage);
    store.update(session, { text: "Sent successfully" });
    store.clear(session);
    expect(createDraftStore(() => storage).read(session).text).toBe("");
    expect(storage.getItem(session)).toBeNull();
    store.update(session, { text: "Delete this" });
    store.update(session, { text: "" });
    expect(storage.getItem(session)).toBeNull();
  });

  it("keeps typing usable when storage is unavailable or corrupt", () => {
    const store = createDraftStore(() => { throw new Error("Storage disabled"); });
    store.update(session, { text: "Still editable" });
    expect(store.read(session).text).toBe("Still editable");
    const storage = new BrowserStorage();
    storage.setItem(session, '{"text":5}');
    expect(createDraftStore(() => storage).read(session).text).toBe("");
  });
});
