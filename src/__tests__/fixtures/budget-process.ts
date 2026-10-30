import Database from "better-sqlite3";
import { GlobalInferenceBudget, GlobalBudgetError } from "../../inference/global-budget.js";
const db = new Database(process.argv[2]);
db.pragma("busy_timeout = 5000");
try {
  const gate = new GlobalInferenceBudget(db, JSON.parse(process.argv[3]), () => new Date("2030-01-15T12:00:00Z"));
  await gate.run({ provider: "test", model: "synthetic", payload: "synthetic", maxOutputTokens: 10 }, async () => "ok", () => ({ inputTokens: 1, outputTokens: 1 }));
  console.log(JSON.stringify({ allowed: true }));
} catch (error) {
  if (!(error instanceof GlobalBudgetError)) throw error;
  console.log(JSON.stringify({ allowed: false }));
} finally { db.close(); }
