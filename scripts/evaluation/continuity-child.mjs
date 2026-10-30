// Deterministic fixture, not a live model client. Executed only by the offline
// evaluation after compilation; never accepts credentials or a provider URL.
import { createDatabase } from "../../dist/state/database.js";
import { GlobalInferenceBudget, GlobalBudgetError } from "../../dist/inference/global-budget.js";
import { runResearchCycle } from "../../dist/evaluation/research-cycle.js";

if (process.env.AUTOMATON_OFFLINE_EVALUATION !== "1") throw new Error("Offline runner required");
const [filename, cycleId, scenario = "normal", indexText = "1", limitText = "20"] = process.argv.slice(2);
if (!filename || !cycleId || !["normal", "kill-reserved", "kill-tools", "kill-turn", "provider-error", "tool-error"].includes(scenario)) {
  throw new Error("Invalid evaluation arguments");
}
const index = Number(indexText), limit = Number(limitText);
if (!Number.isInteger(index) || index < 1 || index > 20 || !Number.isInteger(limit) || limit < 1 || limit > 20) {
  throw new Error("Invalid evaluation limits");
}
const db = createDatabase(filename);
const model = "gemini-offline-fixture";
const budget = new GlobalInferenceBudget(db.raw, {
  enabled: true, dailyMicros: 0, monthlyMicros: 0, perCallMicros: 0,
  dailyRequests: limit, monthlyRequests: limit,
  prices: [{ provider: "offline-fixture", model, inputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
    maxInputTokens: 100000, maxOutputTokens: 256, validUntil: "2031-01-01T00:00:00Z" }],
}, () => new Date("2026-10-30T00:00:00Z"));
let factoryCalls = 0, fixtureCalls = 0;
const kill = () => { process.kill(process.pid, "SIGKILL"); throw new Error("SIGKILL failed"); };
const state = new Proxy(db, { get(target, key) {
  if (key === "insertTurn" && scenario === "kill-tools") return kill;
  if (key === "setAgentState" && scenario === "kill-turn") return value => {
    target.setAgentState(value);
    if (value === "sleeping" && target.getTurnCount() > 0) kill();
  };
  return Reflect.get(target, key);
} });
const action = (name, args) => ({ id: `${cycleId}-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } });
try {
  const status = await runResearchCycle({ db: state, budget, model, cycleId, maxTurns: 1,
    mission: `SIMULATION continuity checkpoint ${index}; actual revenue 0; no market validation.`,
    createInference() {
      factoryCalls++;
      return {
        getDefaultModel: () => model, setLowComputeMode() {},
        chat: (messages, options) => budget.run({ provider: "offline-fixture", model,
          payload: messages, maxOutputTokens: options?.maxTokens, actor: "offline-fixture" }, async () => {
          fixtureCalls++;
          if (scenario === "kill-reserved") kill();
          if (scenario === "provider-error") throw new GlobalBudgetError("Synthetic transport failure");
          const calls = scenario === "tool-error" ? [action("exec", { command: "must-not-execute" })] : [
            ...(index > 1 ? [action("recall_facts", { query: `continuity_${index - 1}` })] : []),
            action("remember_fact", { category: "financial", key: `continuity_${index}`,
              value: `SIMULATION checkpoint ${index}; actual revenue 0`, source: "offline-fixture" }),
            action("sleep", { duration_seconds: 60, reason: "synthetic checkpoint" }),
          ];
          return { id: cycleId, model, message: { role: "assistant", content: "Synthetic fixture only", tool_calls: calls },
            toolCalls: calls, usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 }, finishReason: "stop" };
        }, result => ({ inputTokens: result.usage.promptTokens, outputTokens: result.usage.completionTokens })),
      };
    },
  });
  console.log(JSON.stringify({ offlineContinuity: true, success: true, skipped: status === "already_completed",
    factoryCalls, fixtureCalls, turns: db.getTurnCount(), peakRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024) }));
} catch {
  console.log(JSON.stringify({ offlineContinuity: true, success: false, factoryCalls, fixtureCalls,
    turns: db.getTurnCount(), peakRssMiB: Math.ceil(process.resourceUsage().maxRSS / 1024) }));
  process.exitCode = 2;
} finally { db.close(); }
