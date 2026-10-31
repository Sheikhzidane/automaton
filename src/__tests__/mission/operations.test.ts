/**
 * Milestones, opportunity scoring, task queue, checkpoints, reports and
 * the daily review heartbeat.
 */

import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type BetterSqlite3 from "better-sqlite3";
import { appendLedgerEntry, summariseLedger } from "../../mission/ledger.js";
import { evaluateMilestones } from "../../mission/milestones.js";
import { scoreOpportunity, setOpportunityStatus, upsertOpportunity } from "../../mission/opportunities.js";
import { addMissionTask, computeTaskPriority, getCheckpoint, getNextMissionTask, listMissionTasks, setCheckpoint, updateMissionTask } from "../../mission/tasks.js";
import { buildMissionSnapshot, renderMissionStatus, renderPromptSection } from "../../mission/report.js";
import { runMissionReview } from "../../mission/heartbeat.js";
import { listMissionEvents } from "../../mission/events.js";
import { getMissionConfig } from "../../mission/config.js";
import { createMissionTools } from "../../mission/tools.js";
import type { OpportunityCriteria } from "../../mission/types.js";
import { missionConfig, newDb } from "./helpers.js";

let raw: BetterSqlite3.Database;
let reportsDir: string;

beforeEach(() => {
  raw = newDb().raw;
  reportsDir = fs.mkdtempSync(path.join(os.tmpdir(), "mission-reports-"));
});

const strong: OpportunityCriteria = {
  startupCost: 5,
  demandEvidence: 4,
  timeToFirstCustomer: 4,
  margin: 5,
  revenuePotential: 5,
  lowMaintenance: 3,
  deliverability: 5,
  assetReuse: 5,
  legalAndEthical: true,
};

function settledRevenue(pence: number) {
  return appendLedgerEntry(raw, { entryType: "revenue", status: "settled", amountPence: pence, category: "service", description: "Paid", evidenceRef: `pi_${pence}`, recordedBy: "human" });
}

describe("milestones", () => {
  it("records each stage once, with the supporting ledger entries", () => {
    const mission = getMissionConfig(missionConfig());
    const first = settledRevenue(1200);
    let status = evaluateMilestones(raw, mission, summariseLedger(raw));
    expect(status.currentStage).toBe(1);
    expect(status.newlyAchieved.map((m) => m.stage)).toEqual([1]);
    expect(status.newlyAchieved[0].evidenceEntryIds).toEqual([first.id]);
    expect(status.nextThresholdPence).toBe(5000);

    status = evaluateMilestones(raw, mission, summariseLedger(raw));
    expect(status.newlyAchieved).toHaveLength(0);

    settledRevenue(9000);
    status = evaluateMilestones(raw, mission, summariseLedger(raw));
    expect(status.currentStage).toBe(3);
    expect(status.newlyAchieved.map((m) => m.stage)).toEqual([2, 3]);
    expect(status.progressToTargetPct).toBe(5.1);
  });

  it("does not count pending or related-party money", () => {
    const mission = getMissionConfig(missionConfig());
    appendLedgerEntry(raw, { entryType: "revenue", status: "pending", amountPence: 50000, category: "s", description: "invoice", recordedBy: "human" });
    appendLedgerEntry(raw, { entryType: "revenue", status: "settled", amountPence: 50000, category: "s", description: "own business", evidenceRef: "x", relatedParty: true, recordedBy: "human" });
    expect(evaluateMilestones(raw, mission, summariseLedger(raw)).currentStage).toBe(0);
  });
});

describe("opportunities", () => {
  it("scores 0–100 and rejects anything failing the legal and ethical gate", () => {
    expect(scoreOpportunity({ ...strong, demandEvidence: 5, timeToFirstCustomer: 5, lowMaintenance: 5 }).score).toBe(100);
    expect(scoreOpportunity(strong).score).toBeGreaterThan(80);
    const rejected = upsertOpportunity(raw, { name: "Fake reviews", modelType: "service", criteria: { ...strong, legalAndEthical: false } });
    expect(rejected.status).toBe("rejected");
    expect(() => setOpportunityStatus(raw, rejected.id, "active")).toThrow(/cannot be reactivated/);
  });

  it("validates criteria ranges", () => {
    expect(() => scoreOpportunity({ ...strong, margin: 7 })).toThrow(/0 to 5/);
  });

  it("ranks a high-ticket product with demand above a cheap product with none", () => {
    const highTicket = scoreOpportunity({ ...strong, demandEvidence: 3, timeToFirstCustomer: 3, revenuePotential: 5, lowMaintenance: 2 });
    const cheapPack = scoreOpportunity({ ...strong, demandEvidence: 1, timeToFirstCustomer: 2, revenuePotential: 0.5, lowMaintenance: 5 });
    expect(highTicket.score - cheapPack.score).toBeGreaterThan(15);
  });
});

describe("tasks and checkpoints", () => {
  it("prioritises stages closer to cash and stronger opportunities", () => {
    expect(computeTaskPriority("collect")).toBeLessThan(computeTaskPriority("research"));
    expect(computeTaskPriority("market", 100)).toBeLessThan(computeTaskPriority("market", 0));
  });

  it("orders in-progress work first and never returns blocked tasks as next", () => {
    const research = addMissionTask(raw, { title: "Research", stage: "research" });
    const convert = addMissionTask(raw, { title: "Follow up quote", stage: "convert" });
    expect(getNextMissionTask(raw)?.id).toBe(convert.id);

    updateMissionTask(raw, convert.id, { status: "blocked", blockedReason: "Waiting for reply" });
    updateMissionTask(raw, research.id, { status: "in_progress" });
    expect(getNextMissionTask(raw)?.id).toBe(research.id);
    expect(() => updateMissionTask(raw, research.id, { status: "done" })).toThrow(/result/);
    updateMissionTask(raw, research.id, { status: "done", result: "Found 40 leads" });
    expect(getNextMissionTask(raw)).toBeNull();
    expect(listMissionTasks(raw).map((t) => t.status)).toEqual(["blocked"]);
  });

  it("persists the checkpoint across sessions", () => {
    setCheckpoint(raw, { nextAction: "Visit three venues on the high street", strategy: "Readiness review offer" });
    setCheckpoint(raw, { nextAction: "Send follow-ups" });
    const cp = getCheckpoint(raw);
    expect(cp?.nextAction).toBe("Send follow-ups");
    expect(cp?.strategy).toBe("Readiness review offer");
  });
});

describe("reports", () => {
  it("shows settled figures only and the operating rules", () => {
    const config = missionConfig();
    settledRevenue(1500);
    appendLedgerEntry(raw, { entryType: "revenue", status: "pending", amountPence: 6000, category: "s", description: "invoice", recordedBy: "human" });
    setCheckpoint(raw, { nextAction: "Chase invoice INV-002" });
    const snapshot = buildMissionSnapshot(raw, config);
    const status = renderMissionStatus(snapshot);
    expect(status).toContain("Net earnings:         £15.00");
    expect(status).toContain("Outstanding invoices: £60.00");
    expect(status).toContain("Stage 1 of 7");
    const prompt = renderPromptSection(snapshot);
    expect(prompt).toContain("Chase invoice INV-002");
    expect(prompt).toContain("cannot spend money");
    expect(prompt.length).toBeLessThan(3000);
  });
});

describe("daily review", () => {
  it("writes a report and stays asleep without compute runway", async () => {
    const config = missionConfig({ reportsDir });
    addMissionTask(raw, { title: "Draft offer", stage: "build" });
    const result = await runMissionReview(raw, config, new Date("2026-11-02T07:00:00Z"));
    expect(result.shouldWake).toBe(false);
    expect(result.reportPath && fs.existsSync(result.reportPath)).toBe(true);
    expect(fs.readFileSync(result.reportPath!, "utf-8")).toContain("## Next actions");

    await runMissionReview(raw, config, new Date("2026-11-02T08:00:00Z"));
    expect(listMissionEvents(raw, { types: ["budget_exhausted"] })).toHaveLength(1);
  });

  it("wakes the agent when there is affordable work", async () => {
    const config = missionConfig({ reportsDir });
    appendLedgerEntry(raw, { entryType: "expense", status: "settled", amountPence: 800, category: "compute_prepaid", description: "API credit", evidenceRef: "r1", recordedBy: "human" });
    addMissionTask(raw, { title: "Draft offer", stage: "build" });
    const result = await runMissionReview(raw, config);
    expect(result.shouldWake).toBe(true);
  });

  it("flags an active opportunity with no settled revenue for reassessment", async () => {
    const config = missionConfig({ reportsDir, underperformanceDays: 14 });
    const opp = upsertOpportunity(raw, { name: "Template pack", modelType: "digital product", criteria: strong, status: "active" });
    raw.prepare("UPDATE mission_opportunities SET updated_at = ? WHERE id = ?").run("2026-10-01T00:00:00.000Z", opp.id);
    await runMissionReview(raw, config, new Date("2026-11-02T07:00:00Z"));
    await runMissionReview(raw, config, new Date("2026-11-02T09:00:00Z"));
    const events = listMissionEvents(raw, { types: ["reassess"] });
    expect(events).toHaveLength(1);
    expect(events[0].summary).toContain("Template pack");
  });

  it("does nothing when the mission is off", async () => {
    const result = await runMissionReview(raw, missionConfig({ enabled: false, reportsDir }));
    expect(result).toEqual({ shouldWake: false });
  });
});

describe("agent mission tools", () => {
  it("never include a way to record revenue, decide approvals or grant capital", () => {
    const names = createMissionTools().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["mission_status", "mission_request_approval", "web_fetch"]));
    for (const name of names) {
      expect(name).not.toMatch(/revenue|approve|grant|ledger/);
    }
  });
});
