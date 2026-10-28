/** Deterministic integration evaluation. No real model, wallet, or cloud calls. */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runAgentLoop } from "../../src/agent/loop.js";
import { createDatabase, getHeartbeatSchedule, upsertHeartbeatSchedule } from "../../src/state/database.js";
import { PolicyEngine } from "../../src/agent/policy-engine.js";
import { createDefaultRules } from "../../src/agent/policy-rules/index.js";
import { SpendTracker } from "../../src/agent/spend-tracker.js";
import { createBuiltinTools, executeTool } from "../../src/agent/tools.js";
import { DurableScheduler } from "../../src/heartbeat/scheduler.js";
import { recallFacts } from "../../src/memory/tools.js";
import type { AutomatonDatabase, HeartbeatTaskFn, PolicyRule, TreasuryPolicy } from "../../src/types.js";
import { MockConwayClient, MockInferenceClient, createTestConfig, createTestIdentity, toolCallResponse } from "../../src/__tests__/mocks.js";

vi.mock("../../src/conway/x402.js", async (original) => ({
  ...await original<typeof import("../../src/conway/x402.js")>(),
  getUsdcBalance: vi.fn(async () => 0),
}));

// Zero means unlimited in some model budget fields. Real inference is disabled
// by mocks + OS network denial; these small positive values are secondary caps.
const treasury: TreasuryPolicy = {
  maxSingleTransferCents: 0, maxHourlyTransferCents: 0, maxDailyTransferCents: 0,
  minimumReserveCents: 0, maxX402PaymentCents: 0, x402AllowedDomains: [],
  transferCooldownMs: 60_000, maxTransfersPerTurn: 0,
  maxInferenceDailyCents: 0, requireConfirmationAboveCents: 0,
};
const allowed = new Set(["write_file", "read_file", "remember_fact", "recall_facts", "sleep", "system_synopsis"]);
const evaluationRule: PolicyRule = {
  id: "evaluation.allowlist", priority: -1000,
  description: "Only local evaluation memory, mock files, and sleep are allowed",
  appliesTo: { by: "all" },
  evaluate(request) {
    const fileTool = request.tool.name === "write_file" || request.tool.name === "read_file";
    if (allowed.has(request.tool.name) && (!fileTool || request.args.path === "/root/evaluation/offer.json")) return null;
    return {
      rule: "evaluation.allowlist", action: "deny", reasonCode: "EVALUATION_DISABLED",
      humanMessage: "Disabled in the offline evaluation",
    };
  },
};
const directories: string[] = [];
const databases: AutomatonDatabase[] = [];
function openDatabase(filename?: string) {
  if (!filename) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "automaton-evaluation-"));
    directories.push(directory);
    filename = path.join(directory, "state.db");
  }
  const db = createDatabase(filename);
  databases.push(db);
  return { db, filename };
}
function closeDatabase(db: AutomatonDatabase) {
  db.close();
  databases.splice(databases.indexOf(db), 1);
}
function setup(db: AutomatonDatabase) {
  const base = new MockConwayClient();
  const forbiddenCalls: string[] = [];
  // Fail closed even if a future tool bypasses the policy engine.
  const conway = new Proxy(base, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (["getCreditsBalance", "readFile", "writeFile"].includes(String(key))) return value.bind(target);
      return async () => {
        forbiddenCalls.push(String(key));
        throw new Error(`Offline cloud operation forbidden: ${String(key)}`);
      };
    },
  });
  const config = createTestConfig({
    name: "agent-zero-offline-evaluation", genesisPrompt: "Evaluate a synthetic offer. No external actions or real money.",
    registeredWithConway: false, conwayApiKey: "", conwayApiUrl: "http://invalid.invalid",
    maxChildren: 0, maxTurnsPerCycle: 5, treasuryPolicy: treasury,
    modelStrategy: {
      inferenceModel: "mock-model", lowComputeModel: "mock-model", criticalModel: "mock-model",
      maxTokensPerTurn: 512, hourlyBudgetCents: 50, sessionBudgetCents: 50,
      perCallCeilingCents: 5, enableModelFallback: false, anthropicApiVersion: "2023-06-01",
    },
  });
  const identity = createTestIdentity();
  const policyEngine = new PolicyEngine(db.raw, [evaluationRule, ...createDefaultRules(treasury)]);
  const spendTracker = new SpendTracker(db.raw);
  return { base, forbiddenCalls, identity, config, db, conway, policyEngine, spendTracker, inference: new MockInferenceClient() };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("Agent Zero offline adoption gate", () => {
  it("runs only inside the offline runner with credentials removed and socket creation denied", () => {
    expect(process.env.AUTOMATON_OFFLINE_EVALUATION).toBe("1");
    for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CONWAY_API_KEY", "GEMINI_API_KEY", "GITHUB_TOKEN", "SUPABASE_SERVICE_ROLE_KEY"]) {
      expect(process.env[name]).toBeUndefined();
    }
    execFileSync("python3", ["-c", [
      "import errno, socket",
      "for family in (socket.AF_INET, socket.AF_INET6):",
      "    try:",
      "        socket.socket(family, socket.SOCK_STREAM)",
      "    except OSError as error:",
      "        assert error.errno == errno.EPERM, error",
      "    else:",
      "        raise AssertionError('Network restriction missing')",
    ].join("\n")]);
  });

  it("persists a synthetic commercial mission and resumes after a separate-process database read", async () => {
    const { db, filename } = openDatabase();
    const environment = setup(db);
    const offer = {
      simulation: true, offer: "Configuración de una automatización sencilla",
      unitPriceUsd: 49, variableCostUsd: 9, fixedCostUsd: 20, assumedSales: 3,
      assumedProfitUsd: 100, marketValidated: false, actualRevenueUsd: 0,
    };
    expect((offer.unitPriceUsd - offer.variableCostUsd) * offer.assumedSales - offer.fixedCostUsd).toBe(offer.assumedProfitUsd);
    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "write_file", arguments: { path: "/root/evaluation/offer.json", content: JSON.stringify(offer) } },
        { name: "remember_fact", arguments: { category: "financial", key: "synthetic_offer", value: JSON.stringify(offer), source: "synthetic-fixture" } },
      ]),
      toolCallResponse([
        { name: "transfer_credits", arguments: { to_address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", amount_cents: 1 } },
        { name: "exec", arguments: { command: "echo must-not-execute" } },
        { name: "sleep", arguments: { duration_seconds: 60, reason: "Offline mission completed" } },
      ]),
    ]);
    await runAgentLoop({ ...environment, inference });
    expect(db.getTurnCount()).toBe(2);
    expect(db.getAgentState()).toBe("sleeping");
    expect(JSON.parse(environment.base.files["/root/evaluation/offer.json"])).toEqual(offer);
    expect(recallFacts(db.raw, { query: "synthetic_offer" })).toContain('"actualRevenueUsd":0');
    const denied = db.raw.prepare("SELECT tool_name FROM policy_decisions WHERE decision = 'deny' ORDER BY tool_name").all();
    expect(denied).toEqual([{ tool_name: "exec" }, { tool_name: "transfer_credits" }]);
    expect(environment.forbiddenCalls).toEqual([]);
    closeDatabase(db);

    // A new OS process reads the actual compiled SQLite implementation.
    const child = execFileSync(process.execPath, ["--input-type=module", "-e", [
      'import { createDatabase } from "./dist/state/database.js";',
      'const db = createDatabase(process.argv[1]);',
      'const value = db.raw.prepare("SELECT value FROM semantic_memory WHERE key = ?").get("synthetic_offer");',
      'console.log(JSON.stringify({ turns: db.getTurnCount(), state: db.getAgentState(), offer: JSON.parse(value.value) }));',
      'db.close();',
    ].join("\n"), filename], { encoding: "utf8" });
    const snapshot = JSON.parse(child.trim().split("\n").at(-1)!);
    expect(snapshot).toEqual({ turns: 2, state: "sleeping", offer });

    const resumed = openDatabase(filename).db;
    const second = setup(resumed);
    await runAgentLoop({ ...second, inference: new MockInferenceClient([
      toolCallResponse([{ name: "recall_facts", arguments: { query: "synthetic_offer" } }]),
      toolCallResponse([{ name: "sleep", arguments: { duration_seconds: 60, reason: "Resume verified" } }]),
    ]) });
    expect(resumed.getTurnCount()).toBe(4);
    expect(resumed.getRecentTurns(10).flatMap(turn => turn.toolCalls).find(call => call.name === "recall_facts")?.result).toContain('"marketValidated":false');
    expect(second.forbiddenCalls).toEqual([]);
    expect(resumed.raw.prepare("SELECT COUNT(*) AS count FROM children").get()).toEqual({ count: 0 });
  });

  it("denies payments, replication, shell, self-modification, and network tools before reaching a client", async () => {
    const { db } = openDatabase();
    const context = setup(db);
    const tools = createBuiltinTools(context.identity.sandboxId);
    for (const tool of tools.filter(tool => !allowed.has(tool.name))) {
      const result = await executeTool(tool.name, {}, tools, context, context.policyEngine, {
        inputSource: "wakeup", turnToolCallCount: 0, sessionSpend: context.spendTracker,
      });
      expect(result.error || result.result).toContain("EVALUATION_DISABLED");
    }
    expect(context.forbiddenCalls).toEqual([]);
    const outside = await executeTool("write_file", { path: "/root/other.txt", content: "blocked" }, tools, context, context.policyEngine, {
      inputSource: "wakeup", turnToolCallCount: 0, sessionSpend: context.spendTracker,
    });
    expect(outside.error || outside.result).toContain("EVALUATION_DISABLED");
    expect(context.base.files).toEqual({});
  });

  it("recovers a due scheduled task after a database restart without duplicating the completed run", async () => {
    const { db, filename } = openDatabase();
    const heartbeatConfig = { entries: [], defaultIntervalMs: 60_000, lowComputeMultiplier: 4 };
    upsertHeartbeatSchedule(db.raw, {
      taskName: "evaluation_checkpoint", cronExpression: "", intervalMs: 60_000,
      enabled: 1, priority: 0, timeoutMs: 1000, maxRetries: 0, tierMinimum: "dead",
      lastRunAt: null, nextRunAt: null, lastResult: null, lastError: null,
      runCount: 0, failCount: 0, leaseOwner: null, leaseExpiresAt: null,
    });
    closeDatabase(db);
    const resumed = openDatabase(filename).db;
    const environment = setup(resumed);
    let count = 0;
    const task: HeartbeatTaskFn = async () => {
      count++;
      resumed.setKV("evaluation_checkpoint", "completed");
      return { shouldWake: false };
    };
    const scheduler = new DurableScheduler(resumed.raw, heartbeatConfig, new Map([["evaluation_checkpoint", task]]), environment);
    await scheduler.tick();
    await scheduler.tick();
    expect(count).toBe(1);
    expect(getHeartbeatSchedule(resumed.raw)[0].runCount).toBe(1);
    expect(resumed.getKV("evaluation_checkpoint")).toBe("completed");
    expect(environment.forbiddenCalls).toEqual([]);
  });
});
