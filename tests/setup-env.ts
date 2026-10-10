// Runs before every test file (vitest setupFiles), BEFORE the file's own
// imports, so even static imports of src/shared/paths.ts resolve into a
// throwaway sandbox. No unit test can touch the real .joyride/ runtime.
import { buildSandbox } from "./sandbox.ts";

const dir = `/tmp/joyride-unit-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
// Existing knowledge tests exercise the reversible on mode; freeze tests opt back out.
const sb = buildSandbox(dir, { knowledgePipeline: "on" });
Object.assign(process.env, sb.env, { JOYRIDE_SANDBOX_DIR: dir });
