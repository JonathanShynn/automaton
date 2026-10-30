import { runAgentLoop } from "../agent/loop.js";
import { createGeminiResearchInference } from "../inference/gemini-research.js";
import { GlobalBudgetError, type InferenceBudgetExecutor } from "../inference/global-budget.js";
import { DEFAULT_CONFIG, type AutomatonConfig, type AutomatonDatabase, type AutomatonIdentity, type ConwayClient, type InferenceClient } from "../types.js";
import { runResearchCycleOnce } from "./research-continuity.js";

interface ResearchCycleOptions {
  db: AutomatonDatabase; budget: InferenceBudgetExecutor; model: string; mission: string;
  maxTurns?: number; cycleId?: string;
}

/** One finite research cycle of the real engine. No wallet is loaded/generated,
 * no Conway client is created, and every unsupported service access throws.
 * The caller owns the persistent SQLite connection and shared operator budget.
 */
export async function runGeminiResearchCycle(options: ResearchCycleOptions): Promise<void> {
  await runResearchCycle({ ...options, createInference: () => createGeminiResearchInference(options.model, options.budget) });
}

/** The factory enables deterministic offline evaluation without constructing an
 * SDK client. Production callers use runGeminiResearchCycle. Both use the same
 * real loop, SQLite, capability restrictions, and optional replay guard.
 */
export async function runResearchCycle(options: ResearchCycleOptions & {
  createInference: () => InferenceClient;
}): Promise<"completed" | "already_completed"> {
  const { db, budget, model, mission } = options;
  const maxTurns = options.maxTurns ?? 3;
  if (!mission.trim() || mission.length > 4000 || !Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 5 ||
      !/^gemini-[a-zA-Z0-9_.-]{1,100}$/.test(model) || db.getKV("global_inference_stop") ||
      db.getChildren().some(child => !["dead", "failed", "cleaned_up"].includes(child.status))) {
    throw new GlobalBudgetError("Research mission/state requires operator review");
  }
  const unavailable = new Proxy({}, { get() { throw new GlobalBudgetError("Wallet/Conway unavailable in research mode"); } });
  const identity: AutomatonIdentity = {
    name: "agent-zero-research", address: "0x0000000000000000000000000000000000000000",
    creatorAddress: "0x0000000000000000000000000000000000000000", sandboxId: "research-only",
    apiKey: "", account: unavailable as AutomatonIdentity["account"], createdAt: new Date().toISOString(),
  };
  const config = {
    ...DEFAULT_CONFIG, name: identity.name, genesisPrompt: mission, creatorAddress: identity.creatorAddress,
    walletAddress: identity.address, sandboxId: identity.sandboxId, conwayApiKey: "", conwayApiUrl: "https://example.invalid",
    registeredWithConway: false, financialOperationsEnabled: false, maxChildren: 0,
    inferenceModel: model, maxTurnsPerCycle: maxTurns, maxTokensPerTurn: 256,
    modelStrategy: { inferenceModel: model, lowComputeModel: model, criticalModel: model,
      maxTokensPerTurn: 256, enableModelFallback: false },
  } as AutomatonConfig;
  const run = () => runAgentLoop({ db, identity, config, globalBudget: budget, researchOnly: true,
    conway: unavailable as ConwayClient, inference: options.createInference() });
  if (options.cycleId !== undefined) {
    return runResearchCycleOnce(db, { cycleId: options.cycleId, model, mission, maxTurns }, run);
  }
  await run();
  return "completed";
}
