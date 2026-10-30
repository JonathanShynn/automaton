import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createDatabase } from "../state/database.js";
import { GlobalInferenceBudget } from "../inference/global-budget.js";
import { CONTINUITY_FACTS, continuityTrialPreflight, runGeminiContinuityTrial } from "../evaluation/gemini-continuity-trial.js";

const sdk = vi.hoisted(() => ({ create: vi.fn(), ctor: vi.fn() }));
vi.mock("openai", () => ({ default: class {
  chat = { completions: { create: sdk.create } };
  constructor(options: unknown) { sdk.ctor(options); }
} }));
const directories: string[] = [];
const policy = { enabled: true, dailyMicros: 0, monthlyMicros: 0, perCallMicros: 0, dailyRequests: 3, monthlyRequests: 3,
  prices: [{ provider: "gemini", model: "gemini-3.5-flash-lite", inputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
    maxInputTokens: 32768, maxOutputTokens: 256, validUntil: "2031-01-01T00:00:00Z" }] };
function setup() {
  // Docker supplies a disposable /state tmpfs while keeping /app read-only.
  const directory = fs.mkdtempSync(path.join(fs.existsSync("/state") ? "/state" : process.cwd(), "gemini-continuity-test-")); directories.push(directory);
  vi.stubEnv("GEMINI_API_KEY", "synthetic-secret");
  return { GEMINI_API_KEY: "synthetic-secret", GEMINI_MODEL: "gemini-3.5-flash-lite", GEMINI_FREE_TIER_CONFIRMED: "true",
    GEMINI_CONTINUITY_TRIAL_APPROVED: "true", GEMINI_BUDGET_DB_PATH: path.join(directory, "state.db"),
    GEMINI_BUDGET_POLICY_JSON: JSON.stringify(policy) };
}
function response(phase: number, value: string = CONTINUITY_FACTS[phase - 1].value, recall = true) {
  const actions = [
    ...(phase > 1 && recall ? [{ name: "recall_facts", arguments: { query: CONTINUITY_FACTS[phase - 2].key } }] : []),
    { name: "remember_fact", arguments: { category: "financial", key: CONTINUITY_FACTS[phase - 1].key, value, source: "simulation" } },
    { name: "sleep", arguments: { duration_seconds: 60 } },
  ];
  return { id: "synthetic", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ content: "Simulation", actions }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } };
}
function inspect(env: ReturnType<typeof setup>) {
  const db = createDatabase(env.GEMINI_BUDGET_DB_PATH);
  try { return { turns: db.getTurnCount(), attempts: db.raw.prepare("SELECT status FROM global_inference_attempts").all(),
    stopped: !!db.getKV("global_inference_stop"), receipts: db.raw.prepare("SELECT status FROM research_cycle_receipts ORDER BY cycle_id").all() }; }
  finally { db.close(); }
}
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  sdk.create.mockReset(); sdk.ctor.mockReset(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe("Three-request Gemini continuity trial (mock transport only)", () => {
  it("requires exactly three zero-money requests and new explicit authorization", () => {
    const env = setup(); expect(continuityTrialPreflight(env).report.ready).toBe(true);
    for (const patch of [{ dailyRequests: 4 }, { monthlyRequests: 2 }, { dailyMicros: 1 }, { enabled: false }]) {
      expect(continuityTrialPreflight({ ...env, GEMINI_BUDGET_POLICY_JSON: JSON.stringify({ ...policy, ...patch }) }).report.ready).toBe(false);
    }
    for (const patch of [{ GEMINI_CONTINUITY_TRIAL_APPROVED: "" }, { GEMINI_FREE_TIER_CONFIRMED: "false" },
      { GEMINI_MODEL: "other" }, { GEMINI_BUDGET_DB_PATH: "/tmp/state.db" }]) {
      expect(continuityTrialPreflight({ ...env, ...patch }).report.ready).toBe(false);
    }
    expect(JSON.stringify(continuityTrialPreflight(env).report)).not.toContain("synthetic-secret");
  });

  it("reopens one SQLite file for all three phases, verifies calculations, then audits without a key or client", async () => {
    const env = setup(); const log = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const phase of [1, 2, 3]) {
      sdk.create.mockResolvedValueOnce(response(phase));
      await runGeminiContinuityTrial(["--cycle", String(phase)], env);
      expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ geminiContinuitySuccess: true, phase, turns: phase, providerRequests: phase });
    }
    expect(inspect(env)).toEqual({ turns: 3, attempts: Array(3).fill({ status: "completed" }), stopped: false,
      receipts: Array(3).fill({ status: "completed" }) });
    expect(sdk.create).toHaveBeenCalledTimes(3);
    const secondInput = JSON.stringify(sdk.create.mock.calls[1][0].messages);
    const thirdInput = JSON.stringify(sdk.create.mock.calls[2][0].messages);
    expect(secondInput).toContain(CONTINUITY_FACTS[0].value);
    expect(thirdInput).toContain("gc_margin");
    for (const [options] of sdk.ctor.mock.calls) expect(options).toMatchObject({ maxRetries: 0 });
    sdk.create.mockClear(); sdk.ctor.mockClear(); vi.stubEnv("GEMINI_API_KEY", "");
    await runGeminiContinuityTrial(["--verify"], { GEMINI_BUDGET_DB_PATH: env.GEMINI_BUDGET_DB_PATH });
    expect(JSON.parse(log.mock.calls.at(-1)![0])).toMatchObject({ geminiContinuitySuccess: true, completedCycles: 3, additionalProviderRequests: 0 });
    expect(sdk.create).not.toHaveBeenCalled(); expect(sdk.ctor).not.toHaveBeenCalled();
  });

  it("denies a missing prior checkpoint before constructing any SDK client", async () => {
    const env = setup();
    await expect(runGeminiContinuityTrial(["--cycle", "2"], env)).rejects.toThrow("no automatic retry");
    expect(sdk.ctor).not.toHaveBeenCalled(); expect(sdk.create).not.toHaveBeenCalled();
  });

  it("stops on one failed provider call and retains its reservation across the next phase", async () => {
    const env = setup(); sdk.create.mockRejectedValue(new Error("private provider output"));
    await expect(runGeminiContinuityTrial(["--cycle", "1"], env)).rejects.toThrow("no automatic retry");
    await expect(runGeminiContinuityTrial(["--cycle", "2"], env)).rejects.toThrow("no automatic retry");
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(inspect(env)).toMatchObject({ turns: 0, attempts: [{ status: "uncertain" }], stopped: true, receipts: [{ status: "review" }] });
  });

  it.each(["wrong-calculation", "missing-recall"])("stops on %s without spending the third request", async failure => {
    const env = setup(); sdk.create.mockResolvedValueOnce(response(1));
    await runGeminiContinuityTrial(["--cycle", "1"], env);
    sdk.create.mockResolvedValueOnce(response(2, failure === "wrong-calculation" ? "41" : "40", failure !== "missing-recall"));
    await expect(runGeminiContinuityTrial(["--cycle", "2"], env)).rejects.toThrow("no automatic retry");
    await expect(runGeminiContinuityTrial(["--cycle", "3"], env)).rejects.toThrow("no automatic retry");
    expect(sdk.create).toHaveBeenCalledTimes(2); expect(inspect(env).receipts).toEqual([{ status: "completed" }, { status: "review" }]);
  });

  it("rejects a repeated phase before making an additional request", async () => {
    const env = setup(); sdk.create.mockResolvedValueOnce(response(1));
    await runGeminiContinuityTrial(["--cycle", "1"], env);
    await expect(runGeminiContinuityTrial(["--cycle", "1"], env)).rejects.toThrow("no automatic retry");
    expect(sdk.create).toHaveBeenCalledTimes(1);
  });

  it("allows no second transport even if an internal error occurs after the first provider response", async () => {
    const env = setup(); sdk.create.mockResolvedValue(response(1));
    const original = GlobalInferenceBudget.prototype.run;
    const budgetRun = vi.spyOn(GlobalInferenceBudget.prototype, "run").mockImplementationOnce(async function(this: GlobalInferenceBudget, request, call, usage) {
      await original.call(this, request, call, usage);
      throw new Error("Synthetic internal failure after response");
    });
    await expect(runGeminiContinuityTrial(["--cycle", "1"], env)).rejects.toThrow("no automatic retry");
    expect(sdk.create).toHaveBeenCalledTimes(1); expect(budgetRun).toHaveBeenCalledTimes(1);
    expect(inspect(env)).toMatchObject({ turns: 0, attempts: [{ status: "completed" }], stopped: true });
  });
});
