import { call, herdr, waitUntil } from "./map-seed";

/** Close only the sandbox's fake control pane. */
export async function stopFixtureFirstmate() {
  const status = (await call("GET", "/api/firstmate/status")).body;
  if (status.pane) await herdr("fake.close_pane", { pane_id: status.pane.pane_id });
  await waitUntil(async () => !(await call("GET", "/api/firstmate/status")).body.running);
}

/** Archive the notes this spec adds, preserving earlier specs' notes. */
export async function trackFixtureNotes() {
  const before = new Set((await call<{ id: string }[]>("GET", "/api/notes?limit=10000")).body.map((n) => n.id));
  return async () => {
    for (const n of (await call<{ id: string }[]>("GET", "/api/notes?limit=10000")).body) {
      if (!before.has(n.id)) {
        const result = await call("POST", `/api/notes/${n.id}/archive`);
        if (result.status !== 200) throw new Error(`archive fixture note ${n.id}: ${result.status}`);
      }
    }
  };
}
