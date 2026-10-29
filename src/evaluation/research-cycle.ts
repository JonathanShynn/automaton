import { runAgentLoop } from "../agent/loop.js";
import { createGeminiResearchInference } from "../inference/gemini-research.js";
import { GlobalBudgetError, type InferenceBudgetExecutor } from "../inference/global-budget.js";
import { DEFAULT_CONFIG, type AutomatonConfig, type AutomatonDatabase, type AutomatonIdentity, type ConwayClient } from "../types.js";

/** One finite research cycle of the real engine. No wallet is loaded/generated,
 * no Conway client is created, and every unsupported service access throws.
 * The caller owns the persistent SQLite connection and shared operator budget.
 */
export async function runGeminiResearchCycle(options: {
  db: AutomatonDatabase; budget: InferenceBudgetExecutor; model: string; mission: string; maxTurns?: number;
}): Promise<void> {
  const { db, budget, model, mission } = options;
  if (!mission.trim() || mission.length > 4000 || db.getKV("global_inference_stop") ||
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
    inferenceModel: model, maxTurnsPerCycle: options.maxTurns ?? 3, maxTokensPerTurn: 256,
    modelStrategy: { inferenceModel: model, lowComputeModel: model, criticalModel: model,
      maxTokensPerTurn: 256, enableModelFallback: false },
  } as AutomatonConfig;
  await runAgentLoop({ db, identity, config, globalBudget: budget, researchOnly: true,
    conway: unavailable as ConwayClient, inference: createGeminiResearchInference(model, budget) });
}
