import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { createDatabase } from "../state/database.js";
import { GlobalInferenceBudget, GlobalBudgetError, parseGlobalBudgetPolicy, type InferenceBudgetExecutor } from "../inference/global-budget.js";
import { runGeminiResearchCycle } from "./research-cycle.js";

export const CONTINUITY_FACTS = [
  { key: "gc_offer", value: "SIMULATION: price=49; variable_cost=9; fixed_cost=20; actual_revenue=0; market_validated=false" },
  { key: "gc_margin", value: "40" },
  { key: "gc_profit", value: "100" },
] as const;
const cycleId = (phase: number) => `gemini-continuity-v1-cycle-${phase}`;
const validFilename = (filename: string) => path.isAbsolute(filename) && !/^\/(tmp|dev|proc|sys)(\/|$)/.test(filename);

export function continuityTrialPreflight(env: NodeJS.ProcessEnv = process.env) {
  const missing: string[] = [];
  if (!env.GEMINI_API_KEY?.trim()) missing.push("GEMINI_API_KEY");
  if (env.GEMINI_MODEL !== "gemini-3.5-flash-lite") missing.push("CONFIRMED_MODEL");
  if (env.GEMINI_FREE_TIER_CONFIRMED !== "true" || env.GEMINI_CONTINUITY_TRIAL_APPROVED !== "true") missing.push("CONTINUITY_CONFIRMATIONS");
  if (!validFilename(env.GEMINI_BUDGET_DB_PATH ?? "")) missing.push("PERSISTENT_TRIAL_DB");
  let policy;
  try {
    policy = parseGlobalBudgetPolicy(env.GEMINI_BUDGET_POLICY_JSON ?? "");
    const price = policy.prices[0];
    if (!policy.enabled || policy.dailyMicros !== 0 || policy.monthlyMicros !== 0 || policy.perCallMicros !== 0 ||
        policy.dailyRequests !== 3 || policy.monthlyRequests !== 3 || policy.prices.length !== 1 ||
        !price || price.provider !== "gemini" || price.model !== env.GEMINI_MODEL ||
        price.inputMicrosPerMillion !== 0 || price.outputMicrosPerMillion !== 0 ||
        price.maxInputTokens > 32768 || price.maxOutputTokens !== 256 || Date.parse(price.validUntil) <= Date.now()) {
      missing.push("THREE_REQUEST_ZERO_MONEY_POLICY");
    }
  } catch { missing.push("TRIAL_POLICY"); }
  return { report: { ready: missing.length === 0, missing, secretsPrinted: false }, policy };
}

export function continuityMission(phase: number): string {
  if (![1, 2, 3].includes(phase)) throw new GlobalBudgetError("Invalid continuity phase");
  const target = CONTINUITY_FACTS[phase - 1];
  const actions: { name: string; arguments: Record<string, unknown> }[] = [];
  if (phase > 1) actions.push({ name: "recall_facts", arguments: { query: CONTINUITY_FACTS[phase - 2].key } });
  actions.push({ name: "remember_fact", arguments: { category: "financial", key: target.key,
    value: phase === 1 ? target.value : "<calculated integer as a decimal string>", source: "simulation" } });
  actions.push({ name: "sleep", arguments: { duration_seconds: 60 } });
  const task = phase === 1 ? "Store this synthetic offer." : phase === 2
    ? "Use the gc_offer checkpoint in your persisted history: compute unit contribution = price minus variable_cost."
    : "Use gc_margin from your persisted history: compute assumed profit for 3 sales = 3 times unit contribution minus the fixed cost in gc_offer. These are assumed sales, not real revenue.";
  return `Synthetic continuity test, phase ${phase}. ${task} No real revenue or market validation. ` +
    "Return only the following JSON shape, with precisely these actions in order. " +
    (phase > 1 ? "Replace the value placeholder with the calculated integer string; no units or explanation in value. " : "") +
    JSON.stringify({ content: "Simulation only", actions });
}

function verifyCheckpoint(raw: Database.Database, phase: number) {
  const count = (table: string) => (raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const attempts = count("global_inference_attempts"), turns = count("turns");
  const receiptsExist = !!raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_cycle_receipts'").get();
  const receipts = receiptsExist ? raw.prepare("SELECT cycle_id,status FROM research_cycle_receipts").all() as { cycle_id: string; status: string }[] : [];
  const stopped = raw.prepare("SELECT value FROM kv WHERE key='global_inference_stop'").get();
  const state = raw.prepare("SELECT value FROM kv WHERE key='agent_state'").get() as { value: string } | undefined;
  if (attempts !== phase || turns !== phase || receipts.length !== phase || stopped || count("children") ||
      (phase > 0 && state?.value !== "sleeping") ||
      (raw.prepare("SELECT COUNT(*) AS n FROM global_inference_attempts WHERE status != 'completed'").get() as { n: number }).n ||
      receipts.some(row => row.status !== "completed") || raw.pragma("integrity_check", { simple: true }) !== "ok") {
    throw new GlobalBudgetError("Continuity checkpoint incomplete");
  }
  for (let index = 0; index < phase; index++) {
    const fact = CONTINUITY_FACTS[index];
    const stored = raw.prepare("SELECT value,source FROM semantic_memory WHERE category='financial' AND key=?").get(fact.key) as { value: string; source: string } | undefined;
    if (stored?.value !== fact.value || stored.source !== "simulation" || !receipts.some(row => row.cycle_id === cycleId(index + 1))) {
      throw new GlobalBudgetError("Continuity memory or receipt mismatch");
    }
  }
  if (phase > 1) {
    const previous = CONTINUITY_FACTS[phase - 2];
    const last = raw.prepare("SELECT tool_calls FROM turns ORDER BY timestamp DESC,id DESC LIMIT 1").get() as { tool_calls: string };
    const calls = JSON.parse(last.tool_calls) as { name: string; result: string; error?: string }[];
    if (!calls.some(call => call.name === "recall_facts" && !call.error && call.result.includes(`[financial/${previous.key}] = ${previous.value}`))) {
      throw new GlobalBudgetError("Previous memory was not recalled");
    }
  }
  return { turns, providerRequests: attempts, completedCycles: receipts.length };
}

export async function runGeminiContinuityTrial(args: string[], env: NodeJS.ProcessEnv = process.env) {
  if (args.length === 1 && args[0] === "--verify") {
    if (!validFilename(env.GEMINI_BUDGET_DB_PATH ?? "")) throw new GlobalBudgetError("Invalid verification database");
    const raw = new Database(env.GEMINI_BUDGET_DB_PATH!, { readonly: true, fileMustExist: true });
    try {
      const checkpoint = verifyCheckpoint(raw, 3);
      console.log(JSON.stringify({ geminiContinuitySuccess: true, phase: 4, ...checkpoint,
        checkpointReopened: true, additionalProviderRequests: 0, actualRevenueUsd: 0 }));
    } finally { raw.close(); }
    return;
  }
  const { report, policy } = continuityTrialPreflight(env);
  if (args.length === 1 && args[0] === "--check") { console.log(JSON.stringify(report)); return; }
  if (!report.ready || args.length !== 2 || args[0] !== "--cycle" || !/^[123]$/.test(args[1])) {
    throw new GlobalBudgetError("Continuity setup or phase invalid");
  }
  const phase = Number(args[1]);
  const db = createDatabase(env.GEMINI_BUDGET_DB_PATH!);
  try {
    const budget = new GlobalInferenceBudget(db.raw, policy!);
    verifyCheckpoint(db.raw, phase - 1); // A failed, missing or repeated phase cannot issue a request.
    let attempted = false;
    const oneRequestBudget: InferenceBudgetExecutor = {
      run(request, call, usage) {
        if (attempted) throw new GlobalBudgetError("One request per continuity cycle; replay disabled");
        attempted = true; // Set before reservation, including failures before transport.
        return budget.run(request, call, usage);
      },
    };
    await runGeminiResearchCycle({ db, budget: oneRequestBudget, model: env.GEMINI_MODEL!, cycleId: cycleId(phase), maxTurns: 1,
      mission: continuityMission(phase) });
    const checkpoint = verifyCheckpoint(db.raw, phase);
    console.log(JSON.stringify({ geminiContinuitySuccess: true, phase, ...checkpoint,
      factStored: true, recalled: phase > 1, children: 0, actualRevenueUsd: 0,
      processPeakRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024) }));
  } catch {
    const reason = db.getKV("global_inference_stop") ?? "";
    const failureCode = Number(reason.match(/\[code=(\d+)\]/)?.[1] ?? 6);
    const failureShape = Number(reason.match(/\[shape=(\d+)\]/)?.[1] ?? 0);
    db.setKV("global_inference_stop", "Continuity trial stopped; operator review required");
    if (db.raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_cycle_receipts'").get()) {
      db.raw.prepare("UPDATE research_cycle_receipts SET status='review',failure_code='TRIAL_CHECKPOINT_FAILED' WHERE cycle_id=?")
        .run(cycleId(phase));
    }
    console.log(JSON.stringify({ geminiContinuitySuccess: false, phase, failureCode, failureShape,
      turns: db.getTurnCount(), providerRequests: (db.raw.prepare("SELECT COUNT(*) AS n FROM global_inference_attempts").get() as { n: number }).n }));
    throw new GlobalBudgetError("Continuity trial failed; no automatic retry");
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runGeminiContinuityTrial(process.argv.slice(2)).catch(() => {
    console.error("GEMINI_CONTINUITY_STOPPED_REVIEW_REQUIRED"); process.exitCode = 1;
  });
}
