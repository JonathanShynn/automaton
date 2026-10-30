import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";

export interface InferencePrice {
  provider: string;
  model: string;
  inputMicrosPerMillion: number;
  outputMicrosPerMillion: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  validUntil: string;
}
export interface GlobalBudgetPolicy {
  enabled: boolean;
  dailyMicros: number;
  monthlyMicros: number;
  perCallMicros: number;
  dailyRequests: number;
  monthlyRequests: number;
  prices: InferencePrice[];
}
export interface BudgetRequest {
  provider: string;
  model: string;
  payload: unknown;
  maxOutputTokens?: number;
  actor?: string;
}
export interface BudgetUsage { inputTokens: number; outputTokens: number }
export interface InferenceBudgetExecutor {
  run<T>(request: BudgetRequest, call: (maxOutputTokens: number) => Promise<T>, usage: (result: T) => BudgetUsage | undefined): Promise<T>;
}
export class GlobalBudgetError extends Error {
  constructor(message: string) { super(`GLOBAL_INFERENCE_BUDGET: ${message}`); this.name = "GlobalBudgetError"; }
}
export function requireInferenceBudget(budget?: InferenceBudgetExecutor): InferenceBudgetExecutor {
  if (!budget) throw new GlobalBudgetError("No shared budget was supplied; inference is disabled");
  return budget;
}

function integer(value: unknown, name: string, minimum = 0, maximum = 1_000_000_000_000): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new GlobalBudgetError(`Invalid ${name}`);
  }
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._:/-]{1,160}$/.test(value)) throw new GlobalBudgetError("Invalid provider/model identifier");
}
function validate(raw: GlobalBudgetPolicy): GlobalBudgetPolicy {
  if (!raw || typeof raw !== "object" || typeof raw.enabled !== "boolean" || !Array.isArray(raw.prices)) throw new GlobalBudgetError("Invalid policy");
  for (const name of ["dailyMicros", "monthlyMicros", "perCallMicros", "dailyRequests", "monthlyRequests"] as const) integer(raw[name], name);
  const seen = new Set<string>();
  for (const price of raw.prices) {
    identifier(price.provider); identifier(price.model);
    const key = `${price.provider}/${price.model}`;
    if (seen.has(key)) throw new GlobalBudgetError("Duplicate model price");
    seen.add(key);
    integer(price.inputMicrosPerMillion, "input price"); integer(price.outputMicrosPerMillion, "output price");
    integer(price.maxInputTokens, "input ceiling", 1, 2_000_000); integer(price.maxOutputTokens, "output ceiling", 1, 262_144);
    if (typeof price.validUntil !== "string" || !Number.isFinite(Date.parse(price.validUntil))) throw new GlobalBudgetError("Invalid price expiry");
  }
  // Only these normalized fields can affect accounting or its immutable hash.
  return {
    enabled: raw.enabled, dailyMicros: raw.dailyMicros, monthlyMicros: raw.monthlyMicros,
    perCallMicros: raw.perCallMicros, dailyRequests: raw.dailyRequests, monthlyRequests: raw.monthlyRequests,
    prices: raw.prices.map(p => ({ provider: p.provider, model: p.model, inputMicrosPerMillion: p.inputMicrosPerMillion,
      outputMicrosPerMillion: p.outputMicrosPerMillion, maxInputTokens: p.maxInputTokens,
      maxOutputTokens: p.maxOutputTokens, validUntil: p.validUntil })).sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`)),
  };
}
export function loadGlobalBudgetPolicy(filename: string): GlobalBudgetPolicy {
  if (!fs.existsSync(filename)) throw new GlobalBudgetError("Operator budget policy file is missing");
  try { return validate(JSON.parse(fs.readFileSync(filename, "utf8"))); }
  catch (error) { if (error instanceof GlobalBudgetError) throw error; throw new GlobalBudgetError("Cannot read budget policy"); }
}
export function parseGlobalBudgetPolicy(content: string): GlobalBudgetPolicy {
  try { return validate(JSON.parse(content)); }
  catch (error) { if (error instanceof GlobalBudgetError) throw error; throw new GlobalBudgetError("Invalid budget policy JSON"); }
}

function cost(price: InferencePrice, input: number, output: number): number {
  const numerator = BigInt(input) * BigInt(price.inputMicrosPerMillion) + BigInt(output) * BigInt(price.outputMicrosPerMillion);
  const value = (numerator + 999_999n) / 1_000_000n;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new GlobalBudgetError("Cost overflow");
  return Number(value);
}

/** Shared across the parent, planners and local workers on this SQLite file.
 * Each attempted request permanently consumes its conservative reservation.
 * Errors/unknown usage are never refunded, including after a process restart.
 * This is not a provider-side billing guarantee or a hostile-code sandbox.
 */
export class GlobalInferenceBudget implements InferenceBudgetExecutor {
  private readonly policy: GlobalBudgetPolicy;
  private readonly fingerprint: string;
  constructor(private readonly db: Database.Database, policy: GlobalBudgetPolicy, private readonly now = () => new Date()) {
    this.policy = validate(policy);
    this.fingerprint = createHash("sha256").update(JSON.stringify(this.policy)).digest("hex");
    db.exec(`
      CREATE TABLE IF NOT EXISTS global_inference_policy (id INTEGER PRIMARY KEY CHECK(id=1), fingerprint TEXT NOT NULL, stopped_reason TEXT);
      CREATE TABLE IF NOT EXISTS global_inference_attempts (
        id TEXT PRIMARY KEY, actor TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        day TEXT NOT NULL, month TEXT NOT NULL, reserved_micros INTEGER NOT NULL,
        charged_micros INTEGER NOT NULL, actual_micros INTEGER, status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_global_inference_day ON global_inference_attempts(day);
      CREATE INDEX IF NOT EXISTS idx_global_inference_month ON global_inference_attempts(month);
    `);
    db.transaction(() => {
      db.prepare("INSERT OR IGNORE INTO global_inference_policy (id,fingerprint) VALUES (1,?)").run(this.fingerprint);
      this.assertPolicy();
    }).immediate();
  }
  assertReady(): void {
    if (!this.policy.enabled) throw new GlobalBudgetError("Inference is disabled by the operator policy");
    this.assertPolicy();
  }
  private assertPolicy(): void {
    const row = this.db.prepare("SELECT fingerprint,stopped_reason FROM global_inference_policy WHERE id=1").get() as { fingerprint: string; stopped_reason: string | null };
    if (row.fingerprint !== this.fingerprint) throw new GlobalBudgetError("Policy differs from the persisted operator policy; explicit migration is required");
    if (row.stopped_reason) throw new GlobalBudgetError(`Stopped: ${row.stopped_reason}`);
  }
  async run<T>(request: BudgetRequest, call: (limit: number) => Promise<T>, usage: (result: T) => BudgetUsage | undefined): Promise<T> {
    this.assertReady();
    const price = this.policy.prices.find(p => p.provider === request.provider && p.model === request.model);
    if (!price) throw new GlobalBudgetError("Unknown provider/model price");
    if (Date.parse(price.validUntil) <= this.now().getTime()) throw new GlobalBudgetError("Model price has expired");
    if (request.maxOutputTokens !== undefined) integer(request.maxOutputTokens, "requested output limit", 1, 262_144);
    const outputLimit = Math.min(request.maxOutputTokens ?? price.maxOutputTokens, price.maxOutputTokens);
    // Byte-level input bound plus explicit protocol overhead. No prompt is stored.
    const inputBound = Buffer.byteLength(JSON.stringify(request.payload), "utf8") + 4096;
    if (inputBound > price.maxInputTokens) throw new GlobalBudgetError("Input exceeds the operator token ceiling");
    const reserve = cost(price, inputBound, outputLimit);
    if (reserve > this.policy.perCallMicros) throw new GlobalBudgetError("Per-call budget exhausted");
    const date = this.now().toISOString(), day = date.slice(0, 10), month = date.slice(0, 7), id = randomUUID();
    this.db.transaction(() => {
      this.assertReady();
      for (const [column, window, moneyLimit, requestLimit] of [
        ["day", day, this.policy.dailyMicros, this.policy.dailyRequests],
        ["month", month, this.policy.monthlyMicros, this.policy.monthlyRequests],
      ] as const) {
        const total = this.db.prepare(`SELECT COALESCE(SUM(charged_micros),0) AS money,COUNT(*) AS count FROM global_inference_attempts WHERE ${column}=?`).get(window) as { money: number; count: number };
        if (!Number.isSafeInteger(total.money) || total.money + reserve > moneyLimit || total.count >= requestLimit) throw new GlobalBudgetError(`${column} budget or request limit exhausted`);
      }
      this.db.prepare("INSERT INTO global_inference_attempts (id,actor,provider,model,day,month,reserved_micros,charged_micros,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(id, request.actor ?? "inference", request.provider, request.model, day, month, reserve, reserve, "reserved", date);
    }).immediate();
    let result: T;
    try { result = await call(outputLimit); }
    catch (error) {
      this.db.prepare("UPDATE global_inference_attempts SET status='uncertain' WHERE id=?").run(id);
      throw error;
    }
    const measured = usage(result);
    let actual: number | null = null;
    if (measured && Number.isSafeInteger(measured.inputTokens) && measured.inputTokens > 0 && Number.isSafeInteger(measured.outputTokens) && measured.outputTokens >= 0) {
      actual = cost(price, measured.inputTokens, measured.outputTokens);
    }
    const breach = actual !== null && (actual > reserve || measured!.inputTokens > inputBound || measured!.outputTokens > outputLimit);
    this.db.transaction(() => {
      this.db.prepare("UPDATE global_inference_attempts SET actual_micros=?,charged_micros=?,status=? WHERE id=?")
        .run(actual, Math.max(reserve, actual ?? reserve), breach ? "breached" : actual === null ? "uncertain" : "completed", id);
      if (breach) this.db.prepare("UPDATE global_inference_policy SET stopped_reason='Provider usage exceeded the reserved bound' WHERE id=1").run();
    }).immediate();
    if (breach) throw new GlobalBudgetError("Provider exceeded the reserved token/cost bound; further inference stopped");
    return result;
  }
}
