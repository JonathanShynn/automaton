import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabase } from "../state/database.js";
import { GlobalInferenceBudget, type GlobalBudgetPolicy } from "../inference/global-budget.js";
import { createGeminiResearchInference } from "../inference/gemini-research.js";
import { runGeminiResearchCycle } from "../evaluation/research-cycle.js";
import { researchTrialPreflight } from "../evaluation/research-trial.js";
import { runAgentLoop } from "../agent/loop.js";
import { createTestConfig, createTestDb, createTestIdentity, MockInferenceClient } from "./mocks.js";

const sdk = vi.hoisted(() => ({ create: vi.fn(), ctor: vi.fn() }));
vi.mock("openai", () => ({ default: class {
  chat = { completions: { create: sdk.create } };
  constructor(options: unknown) { sdk.ctor(options); }
} }));
const databases: ReturnType<typeof createDatabase>[] = [];
const directories: string[] = [];
const tools = ["remember_fact", "recall_facts", "sleep"].map(name => ({ type: "function" as const, function: { name, description: name, parameters: {} } }));
function open(filename = ":memory:") { const db = createDatabase(filename); databases.push(db); return db; }
function gate(db: ReturnType<typeof createDatabase>, requests = 5) {
  const policy: GlobalBudgetPolicy = { enabled: true, dailyMicros: 0, monthlyMicros: 0, perCallMicros: 0,
    dailyRequests: requests, monthlyRequests: requests,
    prices: [{ provider: "gemini", model: "gemini-synthetic", inputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
      maxInputTokens: 100_000, maxOutputTokens: 256, validUntil: "2031-01-01T00:00:00Z" }] };
  return new GlobalInferenceBudget(db.raw, policy);
}
function response(actions: unknown[] = [], content = "Synthetic analysis only") {
  return { id: "synthetic", choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ content, actions }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } };
}
afterEach(() => {
  for (const db of databases.splice(0)) { try { db.close(); } catch {} }
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  sdk.create.mockReset(); sdk.ctor.mockReset(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe("Gemini research integration with the real Automaton loop", () => {
  it("persists tool actions and resumes a reopened database without wallet, Conway or extra providers", async () => {
    vi.stubEnv("GEMINI_API_KEY", "synthetic-secret");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-research-")); directories.push(dir);
    const filename = path.join(dir, "state.db"); let db = open(filename);
    sdk.create.mockResolvedValueOnce(response([
      { name: "remember_fact", arguments: { category: "financial", key: "offer", value: "SIMULATION: actual revenue 0; not market validated", source: "synthetic" } },
      { name: "sleep", arguments: { duration_seconds: 60, reason: "checkpoint" } },
    ])).mockResolvedValueOnce(response([
      { name: "recall_facts", arguments: { query: "offer" } },
      { name: "sleep", arguments: { duration_seconds: 60, reason: "resume verified" } },
    ]));
    await runGeminiResearchCycle({ db, budget: gate(db), model: "gemini-synthetic", mission: "Evaluate only a synthetic offer." });
    expect(db.getTurnCount()).toBe(1); expect(db.getAgentState()).toBe("sleeping");
    db.close(); databases.splice(databases.indexOf(db), 1); db = open(filename);
    await runGeminiResearchCycle({ db, budget: gate(db), model: "gemini-synthetic", mission: "Recall the synthetic offer and sleep." });
    expect(db.getTurnCount()).toBe(2);
    expect(db.getRecentTurns(2).flatMap(turn => turn.toolCalls).find(call => call.name === "recall_facts")?.result).toContain("actual revenue 0");
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM global_inference_attempts").get()).toEqual({ n: 2 });
    expect(db.getChildren()).toEqual([]);
    for (const [request] of sdk.create.mock.calls) {
      expect(request.model).toBe("gemini-synthetic"); expect(request.max_tokens).toBe(256);
      expect(request.tools).toBeUndefined(); expect(request.response_format).toEqual({ type: "json_object" });
      expect(request.messages.every((message: any) => message.role !== "tool" && !message.tool_calls)).toBe(true);
      expect(request.messages[1].content).toContain("no operational wallet");
    }
    expect(sdk.ctor).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0, baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/" }));
  });

  it("stops on budget exhaustion and preserves the stop across cycles", async () => {
    vi.stubEnv("GEMINI_API_KEY", "synthetic-secret"); const db = open(); const budget = gate(db, 1);
    sdk.create.mockResolvedValue(response([{ name: "recall_facts", arguments: { query: "test" } }]));
    await runGeminiResearchCycle({ db, budget, model: "gemini-synthetic", mission: "Recall test facts." });
    expect(sdk.create).toHaveBeenCalledTimes(1); expect(db.getKV("global_inference_stop")).toContain("limit exhausted");
    await expect(runGeminiResearchCycle({ db, budget, model: "gemini-synthetic", mission: "Resume" })).rejects.toThrow("review");
    expect(sdk.create).toHaveBeenCalledTimes(1);
  });

  it.each(["exec", "transfer_credits", "spawn_child", "write_file"])("rejects a model-invented %s action before execution", async name => {
    vi.stubEnv("GEMINI_API_KEY", "synthetic-secret"); const db = open();
    sdk.create.mockResolvedValue(response([{ name, arguments: { command: "must-not-run" } }]));
    await runGeminiResearchCycle({ db, budget: gate(db), model: "gemini-synthetic", mission: "Only research." });
    expect(db.getTurnCount()).toBe(0); expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(db.getKV("global_inference_stop")).toContain("operator review");
  });

  it("denies model changes, streaming and forbidden tool definitions without transport", async () => {
    vi.stubEnv("GEMINI_API_KEY", "synthetic-secret"); const db = open(); const client = createGeminiResearchInference("gemini-synthetic", gate(db));
    for (const options of [{ model: "other" }, { stream: true }, { tools: [{ type: "function" as const, function: { name: "exec", description: "bad", parameters: {} } }] }]) {
      await expect(client.chat([{ role: "user", content: "test" }], options)).rejects.toThrow("Unsupported");
    }
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("redacts SDK failures and retains the uncertain reservation without retry", async () => {
    vi.stubEnv("GEMINI_API_KEY", "synthetic-secret"); const db = open();
    sdk.create.mockRejectedValue(Object.assign(new Error("synthetic-secret"), { status: 429 }));
    await expect(createGeminiResearchInference("gemini-synthetic", gate(db)).chat([{ role: "user", content: "test" }], { tools })).rejects.toThrow("operator review");
    expect(sdk.create).toHaveBeenCalledTimes(1);
    expect(db.raw.prepare("SELECT status FROM global_inference_attempts").get()).toEqual({ status: "uncertain" });
  });

  it("fails before initialization when research mode allows payments or unbounded turns", async () => {
    const db = createTestDb(); databases.push(db);
    for (const change of [{ financialOperationsEnabled: true }, { maxTurnsPerCycle: 0 }, { maxTurnsPerCycle: 6 }, { maxChildren: 1 }]) {
      await expect(runAgentLoop({ researchOnly: true, globalBudget: gate(db), db, identity: createTestIdentity(),
        config: createTestConfig({ financialOperationsEnabled: false, maxChildren: 0, maxTurnsPerCycle: 3, ...change }),
        inference: { ...new MockInferenceClient(), getDefaultModel: () => "gemini-synthetic" } as any,
        conway: new Proxy({}, { get() { throw new Error("Conway forbidden"); } }) as any })).rejects.toThrow("Research mode requires");
    }
    expect(sdk.create).not.toHaveBeenCalled();
  });
});


describe("Research trial authorization", () => {
  it("accepts only a confirmed two-request zero-money mission policy", () => {
    const policy = { enabled: true, dailyMicros: 0, monthlyMicros: 0, perCallMicros: 0, dailyRequests: 2, monthlyRequests: 2,
      prices: [{ provider: "gemini", model: "gemini-3.5-flash-lite", inputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
        maxInputTokens: 32768, maxOutputTokens: 256, validUntil: "2031-01-01T00:00:00Z" }] };
    const env = { GEMINI_API_KEY: "synthetic-secret", GEMINI_MODEL: "gemini-3.5-flash-lite", GEMINI_BUDGET_DB_PATH: "/state/research.sqlite",
      GEMINI_FREE_TIER_CONFIRMED: "true", GEMINI_RESEARCH_TRIAL_APPROVED: "true", GEMINI_BUDGET_POLICY_JSON: JSON.stringify(policy) };
    expect(researchTrialPreflight(env).report.ready).toBe(true);
    for (const change of [{ dailyRequests: 3 }, { monthlyRequests: 3 }, { dailyMicros: 1 }, { enabled: false }]) {
      expect(researchTrialPreflight({ ...env, GEMINI_BUDGET_POLICY_JSON: JSON.stringify({ ...policy, ...change }) }).report.ready).toBe(false);
    }
    expect(researchTrialPreflight({ ...env, GEMINI_RESEARCH_TRIAL_APPROVED: "false" }).report.ready).toBe(false);
    expect(researchTrialPreflight({ ...env, GEMINI_BUDGET_DB_PATH: "/tmp/state.db" }).report.ready).toBe(false);
    expect(JSON.stringify(researchTrialPreflight(env).report)).not.toContain("synthetic-secret");
  });
});
