import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GlobalInferenceBudget, requireInferenceBudget, type GlobalBudgetPolicy } from "../inference/global-budget.js";
import { createInferenceClient } from "../conway/inference.js";

const opened: Database.Database[] = [];
const dirs: string[] = [];
const clock = () => new Date("2030-01-15T12:00:00Z");
function policy(extra: Partial<GlobalBudgetPolicy> = {}): GlobalBudgetPolicy {
  return { enabled: true, dailyMicros: 1_000_000, monthlyMicros: 2_000_000,
    perCallMicros: 100_000, dailyRequests: 10, monthlyRequests: 20,
    prices: [{ provider: "test", model: "synthetic", inputMicrosPerMillion: 1_000_000,
      outputMicrosPerMillion: 1_000_000, maxInputTokens: 20_000, maxOutputTokens: 10,
      validUntil: "2031-01-01T00:00:00Z" }], ...extra };
}
function open(filename = ":memory:") { const db = new Database(filename); db.pragma("busy_timeout = 5000"); opened.push(db); return db; }
const request = { provider: "test", model: "synthetic", payload: { messages: ["synthetic-only"] }, maxOutputTokens: 10 };
const usage = () => ({ inputTokens: 1, outputTokens: 1 });
afterEach(() => {
  for (const db of opened.splice(0)) if (db.open) db.close();
  for (const directory of dirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("Persistent global inference budget", () => {
  it("fails closed without a controller, enabled policy, known price or current pricing", async () => {
    expect(() => requireInferenceBudget()).toThrow("No shared budget");
    const callback = vi.fn(async () => "ok");
    await expect(new GlobalInferenceBudget(open(), policy({ enabled: false }), clock).run(request, callback, usage)).rejects.toThrow("disabled");
    const gate = new GlobalInferenceBudget(open(), policy(), clock);
    await expect(gate.run({ ...request, model: "unknown" }, callback, usage)).rejects.toThrow("Unknown");
    const expired = policy(); expired.prices[0].validUntil = "2029-01-01T00:00:00Z";
    await expect(new GlobalInferenceBudget(open(), expired, clock).run(request, callback, usage)).rejects.toThrow("expired");
    expect(callback).not.toHaveBeenCalled();
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER])("rejects invalid accounting limits (%s)", value => {
    expect(() => new GlobalInferenceBudget(open(), policy({ dailyMicros: value }), clock)).toThrow("Invalid");
  });

  it("enforces money and input ceilings before transport", async () => {
    const callback = vi.fn(async () => "ok");
    for (const extra of [{ perCallMicros: 1 }, { dailyMicros: 1 }, { monthlyMicros: 1 }]) {
      await expect(new GlobalInferenceBudget(open(), policy(extra), clock).run(request, callback, usage)).rejects.toThrow("budget");
    }
    const limited = policy(); limited.prices[0].maxInputTokens = 1;
    await expect(new GlobalInferenceBudget(open(), limited, clock).run(request, callback, usage)).rejects.toThrow("Input");
    expect(callback).not.toHaveBeenCalled();
  });

  it("clamps output tokens and never refunds the conservative reservation", async () => {
    const db = open(), gate = new GlobalInferenceBudget(db, policy(), clock);
    const call = vi.fn(async (limit: number) => limit);
    expect(await gate.run({ ...request, maxOutputTokens: 200 }, call, usage)).toBe(10);
    const row = db.prepare("SELECT * FROM global_inference_attempts").get() as any;
    expect(row.actual_micros).toBe(2); expect(row.reserved_micros).toBeGreaterThan(4000);
    expect(row.charged_micros).toBe(row.reserved_micros); expect(row.status).toBe("completed");
    expect(JSON.stringify(row)).not.toContain("synthetic-only");
  });

  it("shares quota across connections, actors and providers, including held in-flight attempts", async () => {
    const db = open(), p = policy({ dailyRequests: 1 });
    p.prices.push({ ...p.prices[0], provider: "other" });
    const parent = new GlobalInferenceBudget(db, p, clock), worker = new GlobalInferenceBudget(db, p, clock);
    let finish!: () => void;
    const pending = parent.run(request, () => new Promise<void>(resolve => { finish = resolve; }), () => undefined);
    const call = vi.fn(async () => "must not run");
    await expect(worker.run({ ...request, provider: "other", actor: "worker" }, call, usage)).rejects.toThrow("request limit");
    finish(); await pending;
    expect(call).not.toHaveBeenCalled();
  });

  it("keeps failed and unknown-usage attempts charged after close/reopen", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "global-budget-")); dirs.push(directory);
    const filename = path.join(directory, "state.db"), p = policy({ dailyRequests: 2 });
    let db = open(filename), gate = new GlobalInferenceBudget(db, p, clock);
    await expect(gate.run(request, async () => { throw new Error("transport uncertain"); }, usage)).rejects.toThrow("uncertain");
    await gate.run(request, async () => "missing usage", () => undefined);
    db.close(); db = open(filename); gate = new GlobalInferenceBudget(db, p, clock);
    await expect(gate.run(request, async () => "forbidden", usage)).rejects.toThrow("request limit");
    expect(db.prepare("SELECT COUNT(*) AS n FROM global_inference_attempts WHERE status='uncertain' AND charged_micros=reserved_micros").get()).toEqual({ n: 2 });
    expect(() => new GlobalInferenceBudget(db, policy({ dailyRequests: 99 }), clock)).toThrow("Policy differs");
  });

  it("stops persistently when a provider reports usage beyond the reserved bound", async () => {
    const db = open(), p = policy(), gate = new GlobalInferenceBudget(db, p, clock);
    await expect(gate.run(request, async () => "over limit", () => ({ inputTokens: 1, outputTokens: 1000 }))).rejects.toThrow("exceeded");
    expect(() => new GlobalInferenceBudget(db, p, clock)).toThrow("Stopped");
  });

  it("resets UTC daily windows while retaining monthly usage", async () => {
    let now = new Date("2030-01-15T23:59:00Z");
    const gate = new GlobalInferenceBudget(open(), policy({ dailyRequests: 1, monthlyRequests: 2 }), () => now);
    await gate.run(request, async () => "first", usage);
    now = new Date("2030-01-16T00:00:00Z");
    await gate.run(request, async () => "second", usage);
    now = new Date("2030-01-17T00:00:00Z");
    await expect(gate.run(request, async () => "third", usage)).rejects.toThrow("month");
  });

  it("cannot oversubscribe a shared SQLite quota from two independent processes", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "global-budget-race-")); dirs.push(directory);
    const filename = path.join(directory, "budget.db");
    const p = policy({ dailyRequests: 1 }); new GlobalInferenceBudget(open(filename), p, clock);
    const execute = promisify(execFile);
    const results = await Promise.all([1, 2].map(() => execute(process.execPath,
      ["--import", "tsx", "src/__tests__/fixtures/budget-process.ts", filename, JSON.stringify(p)], { timeout: 10_000 })));
    expect(results.map(result => JSON.parse(result.stdout.trim()).allowed).sort()).toEqual([false, true]);
  });

  it("the legacy real HTTP transport refuses inference when no shared budget was supplied", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const client = createInferenceClient({ apiUrl: "https://example.invalid", apiKey: "synthetic", defaultModel: "synthetic", maxTokens: 10 });
    await expect(client.chat([{ role: "user", content: "test" }])).rejects.toThrow("No shared budget");
    expect(fetch).not.toHaveBeenCalled();
  });
});
