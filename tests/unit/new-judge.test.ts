import { describe, it, expect, vi } from "vitest";
import { Config } from "../../src/shared/schema.ts";
import { newJudge } from "../../src/modules/new/judge.ts";
import { llm } from "../../src/core/llm.ts";
import { jev, q } from "../../src/core/jev.ts";

vi.mock("../../src/core/llm.ts", () => ({ llm: vi.fn() }));
vi.mock("../../src/core/jev.ts", async importOriginal => ({ ...await importOriginal<typeof import("../../src/core/jev.ts")>(), jev: vi.fn(async () => ({ answers: {}, model: "jev", ms: 0, usage: {} })) }));
const questions = { new_route: q.choice("Route this request", { deterministic: "UI action", firstmate: "Work", agent: "Search" }) };
describe("New routing model settings", () => {
  it("inherits the installed Jev model and uses an explicit New override", async () => {
    const inherited = Config.parse({ jev: { model: "my-jev" } });
    await newJudge(inherited)({}, questions);
    expect(jev).toHaveBeenLastCalledWith({}, questions, { model: "my-jev" });
    await newJudge(Config.parse({ new_models: { routing: { backend: "jev", model: "new-jev" } } }))({}, questions);
    expect(jev).toHaveBeenLastCalledWith({}, questions, { model: "new-jev" });
  });
  it("runs native judgment on the configured account/model/effort and validates the response", async () => {
    vi.mocked(llm).mockResolvedValue({ route: "firstmate", idea: "build-joyride", confidence: 0.91 });
    const cfg = Config.parse({ new_models: { routing: { backend: "codex", model: "gpt-6-luna", account: "codex", effort: "high" } } });
    const judgment = await newJudge(cfg)({ text: "implement export" }, questions);
    expect(judgment).toMatchObject({ model: "gpt-6-luna", answers: { new_route: { choice: "firstmate", probabilities: { firstmate: 0.91 } } } });
    expect(llm).toHaveBeenLastCalledWith(expect.stringContaining("implement export"), expect.objectContaining({ choice: cfg.new_models.routing }));
    vi.mocked(llm).mockResolvedValue({ route: "invented", idea: "new", confidence: 1 });
    await expect(newJudge(cfg)({}, questions)).rejects.toThrow();
  });
});
