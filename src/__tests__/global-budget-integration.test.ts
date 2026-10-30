import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { GlobalInferenceBudget, GlobalBudgetError, type GlobalBudgetPolicy } from "../inference/global-budget.js";
import { createInferenceClient } from "../conway/inference.js";
import { ProviderRegistry } from "../inference/provider-registry.js";
import { UnifiedInferenceClient } from "../inference/inference-client.js";
import { createGeminiRegistry, GEMINI_BASE_URL } from "../inference/gemini.js";
import { geminiPreflight, runGeminiProbe } from "../evaluation/gemini-probe.js";
import { runAgentLoop } from "../agent/loop.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestDb, createTestIdentity } from "./mocks.js";

const mocks = vi.hoisted(() => ({ create: vi.fn(), constructor: vi.fn() }));
vi.mock("openai", () => ({ default: class {
  chat = { completions: { create: mocks.create } };
  constructor(options: unknown) { mocks.constructor(options); }
} }));
vi.mock("../conway/x402.js", async original => ({ ...await original<typeof import("../conway/x402.js")>(), getUsdcBalance: async () => 0 }));
const databases: Database.Database[] = [];
const future = new Date(Date.now() + 86_400_000).toISOString();
function policy(requests = 2): GlobalBudgetPolicy {
  return { enabled: true, dailyMicros: 0, monthlyMicros: 0, perCallMicros: 0, dailyRequests: requests, monthlyRequests: requests,
    prices: ["conway", "alpha", "gemini"].map(provider => ({ provider, model: "gemini-synthetic", inputMicrosPerMillion: 0,
      outputMicrosPerMillion: 0, maxInputTokens: 20_000, maxOutputTokens: 20, validUntil: future })) };
}
function gate(requests = 2) { const db = new Database(":memory:"); databases.push(db); return { db, budget: new GlobalInferenceBudget(db, policy(requests)) }; }
function registry() { return new ProviderRegistry([{ id: "alpha", name: "Synthetic", baseUrl: "https://example.invalid", apiKeyEnvVar: "SYNTHETIC_TEST_KEY", enabled: true,
  priority: 1, maxRequestsPerMinute: 10, maxTokensPerMinute: 10000,
  models: [{ id: "gemini-synthetic", tier: "fast", contextWindow: 20_000, maxOutputTokens: 1000, costPerInputToken: 0, costPerOutputToken: 0,
    supportsTools: true, supportsVision: false, supportsStreaming: true }] }]); }
const completion = () => ({ choices: [{ message: { content: "synthetic" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); mocks.create.mockReset(); mocks.constructor.mockReset(); });

describe("Shared budget at real inference boundaries", () => {
  it("accounts parent HTTP and planner/worker SDK calls against the same quota and caps output", async () => {
    const { db, budget } = gate();
    const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => {
      expect(JSON.parse(String(options?.body)).max_tokens).toBe(20);
      return new Response(JSON.stringify(completion()), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch); mocks.create.mockResolvedValue(completion());
    const parent = createInferenceClient({ apiUrl: "https://example.invalid", apiKey: "synthetic", defaultModel: "gemini-synthetic", maxTokens: 500, globalBudget: budget });
    await parent.chat([{ role: "user", content: "synthetic" }]);
    const worker = new UnifiedInferenceClient(registry(), budget);
    await worker.chatDirect({ providerId: "alpha", modelId: "gemini-synthetic", messages: [{ role: "user", content: "synthetic" }], maxTokens: 500 });
    await expect(worker.chatDirect({ providerId: "alpha", modelId: "gemini-synthetic", messages: [{ role: "user", content: "third" }] })).rejects.toThrow(GlobalBudgetError);
    expect(fetch).toHaveBeenCalledTimes(1); expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0][0].max_tokens).toBe(20);
    expect(mocks.constructor).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 0 }));
    expect(db.prepare("SELECT actor FROM global_inference_attempts ORDER BY rowid").all()).toEqual([{ actor: "parent" }, { actor: "planner-worker" }]);
  });

  it("reserves every SDK retry, stops before an unbudgeted retry, and never doubles SDK retries", async () => {
    vi.useFakeTimers(); const { db, budget } = gate(1);
    mocks.create.mockRejectedValue(Object.assign(new Error("synthetic 503"), { status: 503 }));
    const client = new UnifiedInferenceClient(registry(), budget);
    const promise = client.chatDirect({ providerId: "alpha", modelId: "gemini-synthetic", messages: [{ role: "user", content: "test" }] });
    const assertion = expect(promise).rejects.toThrow(GlobalBudgetError);
    await vi.runAllTimersAsync(); await assertion;
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT status FROM global_inference_attempts").get()).toEqual({ status: "uncertain" });
  });

  it("retains reservations when a stream omits usage", async () => {
    const { db, budget } = gate(1);
    mocks.create.mockImplementation(async () => (async function* () { yield { choices: [{ delta: { content: "synthetic" } }] }; })());
    await new UnifiedInferenceClient(registry(), budget).chatDirect({ providerId: "alpha", modelId: "gemini-synthetic", messages: [{ role: "user", content: "test" }], stream: true });
    expect(db.prepare("SELECT status FROM global_inference_attempts").get()).toEqual({ status: "uncertain" });
  });

  it("a missing SDK budget fails before the SDK transport", async () => {
    await expect(new UnifiedInferenceClient(registry()).chatDirect({ providerId: "alpha", modelId: "gemini-synthetic", messages: [{ role: "user", content: "test" }] })).rejects.toThrow("No shared budget");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("a budget failure stops the parent cycle immediately", async () => {
    const db = createTestDb(); const inference = new MockInferenceClient();
    const chat = vi.spyOn(inference, "chat").mockRejectedValue(new GlobalBudgetError("synthetic exhausted quota"));
    try {
      await runAgentLoop({ db, config: createTestConfig(), identity: createTestIdentity(), conway: new MockConwayClient(), inference });
      expect(chat).toHaveBeenCalledTimes(1); expect(db.getAgentState()).toBe("sleeping");
      expect(db.getKV("global_inference_stop")).toContain("exhausted quota");
    } finally { db.close(); }
  });
});

describe("Gemini preparation without credentials", () => {
  it("uses the official endpoint, explicit model and no alternate provider", () => {
    const configured = createGeminiRegistry("gemini-synthetic").getProviders();
    expect(configured).toHaveLength(1); expect(configured[0].baseUrl).toBe(GEMINI_BASE_URL);
    expect(configured[0].apiKeyEnvVar).toBe("GEMINI_API_KEY");
    expect(() => createGeminiRegistry("other-model")).toThrow();
  });
  it("preflight reports only fixed requirement names and never secrets or a network request", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const report = geminiPreflight({ GEMINI_API_KEY: "SYNTHETIC_PRIVATE_VALUE" }).report;
    expect(report.ready).toBe(false); expect(JSON.stringify(report)).not.toContain("SYNTHETIC_PRIVATE_VALUE");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await runGeminiProbe(["--check"]);
    await expect(runGeminiProbe(["--live"])).rejects.toThrow("HUMAN_SETUP_REQUIRED");
    expect(log).toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(mocks.create).not.toHaveBeenCalled();
  });
});
