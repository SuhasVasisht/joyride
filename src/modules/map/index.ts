// Read-only map layout and theme from workspace.yaml. Authored group positions
// still live in map/layout.yaml and are owned by the missions module.
import fs from "node:fs";
import YAML from "yaml";
import { defineModule } from "../../core/context.ts";
import { paths } from "../../shared/paths.ts";
import { WorkspaceSpec } from "../../shared/schema.ts";

let refresh: (() => void) | null = null;
let timer: NodeJS.Timeout | null = null;

export default defineModule({
  name: "map",
  order: 20,
  register(ctx) {
    let spec = WorkspaceSpec.parse({});
    let previous: string | null = null;
    const read = () => {
      let text: string;
      try { text = fs.readFileSync(paths.workspace, "utf8"); }
      catch { text = ""; }
      if (text === previous) return;
      previous = text;
      try { spec = WorkspaceSpec.parse(YAML.parse(text) ?? {}); }
      catch (error) {
        ctx.log("map: workspace.yaml is invalid; keeping the last readable layout. Fix the YAML to reload it.", String(error));
      }
      ctx.bus.change({ entity: "workspace" });
    };
    refresh = read;
    read();
    ctx.app.get("/api/workspace/spec", (c) => { read(); return c.json(spec); });
  },
  start() { timer = setInterval(() => refresh?.(), 1000); timer.unref(); },
  stop() { if (timer) clearInterval(timer); timer = null; refresh = null; },
});
