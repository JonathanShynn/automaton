import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createDatabase } from "../../src/state/database.js";

const directories: string[] = [];
function database() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "continuity-evaluation-")); directories.push(dir);
  const filename = path.join(dir, "state.db"); createDatabase(filename).close(); return filename;
}
function run(filename: string, id: string, scenario = "normal", index = 1, limit = 20) {
  const child = spawnSync(process.execPath, ["scripts/evaluation/continuity-child.mjs", filename, id, scenario, String(index), String(limit)],
    { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
  if (child.error) throw child.error;
  const last = child.stdout.trim().split("\n").at(-1);
  return { status: child.status, signal: child.signal, summary: last?.startsWith('{"offlineContinuity"') ? JSON.parse(last) : null };
}
function snapshot(filename: string) {
  const db = createDatabase(filename);
  try {
    return { turns: db.getTurnCount(), children: db.getChildren().length,
      facts: (db.raw.prepare("SELECT COUNT(*) AS n FROM semantic_memory WHERE source='offline-fixture'").get() as any).n,
      attempts: db.raw.prepare("SELECT status FROM global_inference_attempts").all(),
      cycles: db.raw.prepare("SELECT cycle_id,status FROM research_cycle_receipts ORDER BY cycle_id").all(),
      recalled: db.getRecentTurns(20).flatMap(turn => turn.toolCalls).filter(call => call.name === "recall_facts").map(call => call.result),
      integrity: db.raw.pragma("integrity_check", { simple: true }), stopped: !!db.getKV("global_inference_stop") };
  } finally { db.close(); }
}
afterEach(() => { for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe("Bounded continuity across separate OS processes (synthetic inference)", () => {
  it("runs six checkpoint cycles, recalls previous work, and skips every completed replay before client construction", () => {
    expect(process.env.AUTOMATON_OFFLINE_EVALUATION).toBe("1");
    const filename = database(); let peak = 0;
    for (let index = 1; index <= 6; index++) {
      const result = run(filename, `cycle-${index}`, "normal", index);
      expect(result.status).toBe(0); expect(result.summary).toMatchObject({ success: true, skipped: false, fixtureCalls: 1, turns: index });
      peak = Math.max(peak, result.summary.peakRssMiB);
      const duplicate = run(filename, `cycle-${index}`, "normal", index);
      expect(duplicate.status).toBe(0); expect(duplicate.summary).toMatchObject({ skipped: true, factoryCalls: 0, fixtureCalls: 0, turns: index });
    }
    const state = snapshot(filename);
    expect(state).toMatchObject({ turns: 6, facts: 6, children: 0, integrity: "ok", stopped: false });
    expect(state.attempts).toEqual(Array(6).fill({ status: "completed" }));
    expect(state.cycles).toHaveLength(6); expect(state.cycles.every((row: any) => row.status === "completed")).toBe(true);
    expect(state.recalled).toHaveLength(5); expect(state.recalled.every(text => text.includes("actual revenue 0"))).toBe(true);
    console.log(JSON.stringify({ offlineContinuity: true, simulatedCycles: 6, completedReplaysSkipped: 6,
      restoredMemories: 5, fixtureRequests: 6, liveProviderRequests: 0, peakRssMiB: peak }));
  }, 70000);

  it.each([
    ["kill-reserved", 0, 0, "reserved"], ["kill-tools", 1, 0, "completed"], ["kill-turn", 1, 1, "completed"],
  ])("retains the reservation and blocks replay after SIGKILL at %s", (scenario, facts, turns, attemptStatus) => {
    const filename = database();
    expect(run(filename, "interrupted", scenario as string).signal).toBe("SIGKILL");
    const before = snapshot(filename);
    expect(before).toMatchObject({ facts, turns, attempts: [{ status: attemptStatus }], cycles: [{ cycle_id: "interrupted", status: "running" }], integrity: "ok" });
    expect(run(filename, "interrupted", scenario as string).summary).toMatchObject({ success: false, factoryCalls: 0, fixtureCalls: 0 });
    expect(run(filename, "next-cycle").summary).toMatchObject({ success: false, factoryCalls: 0, fixtureCalls: 0 });
    expect(snapshot(filename)).toEqual(before);
  });

  it("stops after a transport failure and rejects the failed cycle on restart without a second attempt", () => {
    const filename = database();
    expect(run(filename, "failed", "provider-error").summary).toMatchObject({ success: false, fixtureCalls: 1 });
    const before = snapshot(filename);
    expect(before).toMatchObject({ turns: 0, facts: 0, stopped: true,
      attempts: [{ status: "uncertain" }], cycles: [{ cycle_id: "failed", status: "review" }] });
    expect(run(filename, "failed", "provider-error").summary).toMatchObject({ success: false, factoryCalls: 0, fixtureCalls: 0 });
    expect(snapshot(filename)).toEqual(before);
  });

  it("retains an exhausted one-request limit across process restarts", () => {
    const filename = database();
    expect(run(filename, "first", "normal", 1, 1).status).toBe(0);
    expect(run(filename, "second", "normal", 2, 1).summary).toMatchObject({ success: false, fixtureCalls: 0 });
    const before = snapshot(filename);
    expect(before).toMatchObject({ turns: 1, facts: 1, stopped: true, attempts: [{ status: "completed" }] });
    expect(run(filename, "third", "normal", 3, 1).summary).toMatchObject({ success: false, factoryCalls: 0 });
    expect(snapshot(filename)).toEqual(before);
  });

  it("does not certify a turn whose tool failed", () => {
    const filename = database();
    expect(run(filename, "bad-tool", "tool-error").summary).toMatchObject({ success: false, fixtureCalls: 1 });
    expect(snapshot(filename)).toMatchObject({ turns: 1, facts: 0, children: 0, cycles: [{ cycle_id: "bad-tool", status: "review" }] });
  });

  it("admits only one of two concurrent processes using the same cycle identifier", async () => {
    const filename = database();
    const invoke = () => promisify(execFile)(process.execPath,
      ["scripts/evaluation/continuity-child.mjs", filename, "concurrent"], { timeout: 15000 }).then(() => {}, error => {
        expect(error.code).toBe(2); // The losing process can see running or completed.
      });
    await Promise.all([invoke(), invoke()]);
    expect(snapshot(filename)).toMatchObject({ turns: 1, facts: 1, children: 0,
      attempts: [{ status: "completed" }], cycles: [{ cycle_id: "concurrent", status: "completed" }], integrity: "ok" });
  });
});
