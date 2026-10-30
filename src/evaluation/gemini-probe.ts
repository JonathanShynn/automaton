#!/usr/bin/env node
import Database from "better-sqlite3";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GlobalInferenceBudget, GlobalBudgetError, parseGlobalBudgetPolicy, type GlobalBudgetPolicy } from "../inference/global-budget.js";
import { createGeminiRegistry } from "../inference/gemini.js";
import { UnifiedInferenceClient } from "../inference/inference-client.js";

export function geminiPreflight(env: NodeJS.ProcessEnv = process.env) {
  const missing: string[] = [];
  if (!env.GEMINI_API_KEY?.trim()) missing.push("GEMINI_API_KEY");
  if (!/^gemini-[a-zA-Z0-9_.-]{1,100}$/.test(env.GEMINI_MODEL ?? "")) missing.push("GEMINI_MODEL");
  if (env.GEMINI_FREE_TIER_CONFIRMED !== "true") missing.push("GEMINI_FREE_TIER_CONFIRMED");
  if (env.GEMINI_LIVE_PROBE_APPROVED !== "true") missing.push("GEMINI_LIVE_PROBE_APPROVED");
  const filename = env.GEMINI_BUDGET_DB_PATH ?? "";
  if (!path.isAbsolute(filename) || /^\/(tmp|dev|proc|sys)(\/|$)/.test(filename)) missing.push("PERSISTENT_GEMINI_BUDGET_DB_PATH");
  let policy: GlobalBudgetPolicy | undefined;
  try {
    policy = parseGlobalBudgetPolicy(env.GEMINI_BUDGET_POLICY_JSON ?? "");
    const price = policy.prices.find(p => p.provider === "gemini" && p.model === env.GEMINI_MODEL);
    if (!policy.enabled || policy.dailyMicros !== 0 || policy.monthlyMicros !== 0 || policy.perCallMicros !== 0 ||
      policy.dailyRequests !== 1 || policy.monthlyRequests < 1 || policy.monthlyRequests > 5 || policy.prices.length !== 1 ||
      !price || price.inputMicrosPerMillion !== 0 || price.outputMicrosPerMillion !== 0 || Date.parse(price.validUntil) <= Date.now()) {
      missing.push("ENABLED_ZERO_MONEY_BUDGET_FOR_CONFIRMED_MODEL");
    }
  } catch { missing.push("GEMINI_BUDGET_POLICY_JSON"); }
  return { report: { ready: missing.length === 0, missing, networkRequests: 0, secretsPrinted: false }, policy };
}

export async function runGeminiProbe(args: string[]): Promise<void> {
  const env = process.env;
  const preflight = geminiPreflight(env);
  if (args.length === 1 && args[0] === "--check") {
    console.log(JSON.stringify(preflight.report));
    return;
  }
  if (args.length !== 1 || args[0] !== "--live") throw new Error("Use --check for a network-free preflight or --live after operator setup");
  if (!preflight.report.ready) {
    console.log(JSON.stringify(preflight.report));
    throw new Error("HUMAN_SETUP_REQUIRED");
  }
  const db = new Database(env.GEMINI_BUDGET_DB_PATH!);
  try {
    const budget = new GlobalInferenceBudget(db, preflight.policy!);
    const registry = createGeminiRegistry(env.GEMINI_MODEL!);
    const inference = new UnifiedInferenceClient(registry, budget);
    const response = await inference.chatDirect({ providerId: "gemini", modelId: env.GEMINI_MODEL!,
      messages: [{ role: "user", content: "Responde únicamente: conexión de prueba correcta." }], maxTokens: 256 });
    console.log(JSON.stringify({ success: true, inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens, nonemptyAnswer: response.content.length > 0 }));
  } finally { db.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runGeminiProbe(process.argv.slice(2)).catch(error => {
    // Never log raw SDK errors: a provider can echo credentials or prompts.
    console.error(error instanceof GlobalBudgetError ? error.message : "GEMINI_PROBE_FAILED_OR_HUMAN_SETUP_REQUIRED");
    process.exitCode = 1;
  });
}
