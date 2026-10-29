import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDatabase } from "../state/database.js";
import { GlobalInferenceBudget, GlobalBudgetError, parseGlobalBudgetPolicy } from "../inference/global-budget.js";
import { runGeminiResearchCycle } from "./research-cycle.js";

export const TRIAL_FACT = "SIMULATION: price 49, variable cost 9, fixed cost 20; actual revenue 0; market not validated";
export function researchTrialPreflight(env: NodeJS.ProcessEnv = process.env) {
  const missing: string[] = [];
  if (!env.GEMINI_API_KEY?.trim()) missing.push("GEMINI_API_KEY");
  if (env.GEMINI_MODEL !== "gemini-3.5-flash-lite") missing.push("CONFIRMED_MODEL");
  if (env.GEMINI_FREE_TIER_CONFIRMED !== "true" || env.GEMINI_RESEARCH_TRIAL_APPROVED !== "true") missing.push("TRIAL_CONFIRMATIONS");
  const filename = env.GEMINI_BUDGET_DB_PATH ?? "";
  if (!path.isAbsolute(filename) || /^\/(tmp|dev|proc|sys)(\/|$)/.test(filename)) missing.push("PERSISTENT_TRIAL_DB");
  let policy;
  try {
    policy = parseGlobalBudgetPolicy(env.GEMINI_BUDGET_POLICY_JSON ?? "");
    const price = policy.prices[0];
    if (!policy.enabled || policy.dailyMicros !== 0 || policy.monthlyMicros !== 0 || policy.perCallMicros !== 0 ||
        policy.dailyRequests !== 2 || policy.monthlyRequests !== 2 || policy.prices.length !== 1 ||
        !price || price.provider !== "gemini" || price.model !== env.GEMINI_MODEL ||
        price.inputMicrosPerMillion !== 0 || price.outputMicrosPerMillion !== 0 ||
        price.maxInputTokens > 32768 || price.maxOutputTokens !== 256 || Date.parse(price.validUntil) <= Date.now()) missing.push("TWO_REQUEST_ZERO_MONEY_POLICY");
  } catch { missing.push("TRIAL_POLICY"); }
  return { report: { ready: missing.length === 0, missing, secretsPrinted: false }, policy };
}

export async function runResearchTrial(args: string[]) {
  const env = process.env; const { report, policy } = researchTrialPreflight(env);
  if (args.length === 1 && args[0] === "--check") { console.log(JSON.stringify(report)); return; }
  if (!report.ready || args.length !== 1 || !["--store", "--resume"].includes(args[0])) throw new GlobalBudgetError("Research trial setup/phase invalid");
  const db = createDatabase(env.GEMINI_BUDGET_DB_PATH!);
  try {
    const resume = args[0] === "--resume";
    const budget = new GlobalInferenceBudget(db.raw, policy!);
    const count = () => (db.raw.prepare("SELECT COUNT(*) AS n FROM global_inference_attempts").get() as { n: number }).n;
    const expected = resume ? 1 : 0;
    if (count() !== expected || db.getTurnCount() !== expected) throw new GlobalBudgetError("Trial cannot be replayed or restarted after an uncertain attempt");
    if (resume) {
      const saved = db.raw.prepare("SELECT value FROM semantic_memory WHERE key='research_trial_offer'").get() as { value: string } | undefined;
      if (saved?.value !== TRIAL_FACT) throw new GlobalBudgetError("Prior checkpoint missing");
    }
    const mission = resume
      ? 'This is a synthetic test. Produce exactly two local actions: recall_facts with query "research_trial_offer", then sleep with duration_seconds 60. Keep content brief.'
      : 'This is a synthetic test, not a real business. Produce exactly two local actions: remember_fact with category "financial", key "research_trial_offer", source "simulation", value exactly ' + JSON.stringify(TRIAL_FACT) + '; then sleep with duration_seconds 60. Keep content brief.';
    await runGeminiResearchCycle({ db, budget, model: env.GEMINI_MODEL!, mission, maxTurns: 1 });
    const fact = db.raw.prepare("SELECT value FROM semantic_memory WHERE key='research_trial_offer'").get() as { value: string } | undefined;
    const recalled = db.getRecentTurns(1).flatMap(turn => turn.toolCalls).some(call => call.name === "recall_facts" && call.result.includes(TRIAL_FACT));
    if (db.getKV("global_inference_stop") || db.getTurnCount() !== expected + 1 || count() !== expected + 1 ||
        fact?.value !== TRIAL_FACT || (resume && !recalled) || db.getAgentState() !== "sleeping" || db.getChildren().length) {
      throw new GlobalBudgetError("Research trial assertions failed; no automatic retry");
    }
    console.log(JSON.stringify({ researchTrialSuccess: true, phase: args[0], turns: db.getTurnCount(),
      providerRequests: count(), factStored: true, recalled, children: 0, actualRevenueUsd: 0,
      processPeakRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024) }));
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runResearchTrial(process.argv.slice(2)).catch(() => { console.error("RESEARCH_TRIAL_STOPPED_REVIEW_REQUIRED"); process.exitCode = 1; });
}
