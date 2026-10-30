import { createHash } from "node:crypto";
import type { AutomatonDatabase } from "../types.js";
import { GlobalBudgetError } from "../inference/global-budget.js";

export interface ResearchCycleIdentity {
  cycleId: string;
  model: string;
  mission: string;
  maxTurns: number;
}

/** Durable replay guard for one database and trusted research code.
 * An interrupted cycle is never retried automatically: local tool effects and
 * the final receipt cannot be made one transaction across arbitrary awaits.
 * This deliberately provides at-most-one admission, not exactly-once effects.
 */
export async function runResearchCycleOnce(
  db: AutomatonDatabase,
  identity: ResearchCycleIdentity,
  run: () => Promise<void>,
): Promise<"completed" | "already_completed"> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(identity.cycleId)) {
    throw new GlobalBudgetError("Invalid research cycle identifier");
  }
  const fingerprint = createHash("sha256").update(JSON.stringify([
    identity.model, identity.mission, identity.maxTurns,
  ])).digest("hex");
  db.raw.exec(`CREATE TABLE IF NOT EXISTS research_cycle_receipts (
    cycle_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','completed','review')),
    started_at TEXT NOT NULL, finished_at TEXT, failure_code TEXT
  )`);
  const admitted = db.raw.transaction(() => {
    const previous = db.raw.prepare("SELECT fingerprint,status FROM research_cycle_receipts WHERE cycle_id=?")
      .get(identity.cycleId) as { fingerprint: string; status: string } | undefined;
    if (previous?.fingerprint !== undefined && previous.fingerprint !== fingerprint) {
      throw new GlobalBudgetError("Research cycle identifier reused with different instructions");
    }
    if (previous?.status === "completed") return false;
    if (db.raw.prepare("SELECT 1 FROM research_cycle_receipts WHERE status != 'completed' LIMIT 1").get()) {
      throw new GlobalBudgetError("Active or unfinished research cycle requires operator review; replay disabled");
    }
    if (db.getKV("global_inference_stop")) throw new GlobalBudgetError("Inference is stopped; operator review required");
    db.raw.prepare("INSERT INTO research_cycle_receipts (cycle_id,fingerprint,status,started_at) VALUES (?,?,'running',?)")
      .run(identity.cycleId, fingerprint, new Date().toISOString());
    return true;
  }).immediate();
  if (!admitted) return "already_completed";

  const turnsBefore = db.getTurnCount();
  try {
    await run();
    const added = db.getTurnCount() - turnsBefore;
    if (db.getKV("global_inference_stop") || added < 1 || added > identity.maxTurns ||
        db.getAgentState() !== "sleeping" ||
        db.getRecentTurns(added).some(turn => turn.toolCalls.some(call => call.error))) {
      throw new GlobalBudgetError("Research cycle did not finish cleanly; operator review required");
    }
    db.raw.prepare("UPDATE research_cycle_receipts SET status='completed',finished_at=? WHERE cycle_id=? AND status='running'")
      .run(new Date().toISOString(), identity.cycleId);
    return "completed";
  } catch {
    // Do not persist provider errors, prompts, credentials, or arbitrary output.
    db.raw.prepare("UPDATE research_cycle_receipts SET status='review',failure_code='CYCLE_INCOMPLETE' WHERE cycle_id=? AND status='running'")
      .run(identity.cycleId);
    throw new GlobalBudgetError("Research cycle incomplete; operator review required; replay disabled");
  }
}
