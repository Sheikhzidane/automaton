/**
 * Mission milestones.
 *
 * A milestone is recorded the first time countable net earnings reach its
 * threshold, together with the IDs of the settled revenue entries that
 * support it. Records are never removed; if a refund later pulls net
 * earnings back below a threshold, the current stage reflects that while
 * the history still shows when it was first reached.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { LedgerSummary, MissionConfig } from "./types.js";
import { isCountableRevenue, listEffectiveLedgerEntries } from "./ledger.js";
import { recordMissionEvent } from "./events.js";

type Database = BetterSqlite3.Database;

export interface MilestoneRecord {
  stage: number;
  thresholdPence: number;
  achievedAt: string;
  netPenceAtAchievement: number;
  evidenceEntryIds: string[];
}

export interface MilestoneStatus {
  /** Highest stage currently satisfied by net earnings (0 = none). */
  currentStage: number;
  nextStage: number | null;
  nextThresholdPence: number | null;
  achieved: MilestoneRecord[];
  newlyAchieved: MilestoneRecord[];
  progressToTargetPct: number;
}

function toRecord(r: any): MilestoneRecord {
  let ids: string[] = [];
  try {
    ids = JSON.parse(r.evidence_entry_ids);
  } catch {
    ids = [];
  }
  return {
    stage: r.stage,
    thresholdPence: r.threshold_pence,
    achievedAt: r.achieved_at,
    netPenceAtAchievement: r.net_pence_at_achievement,
    evidenceEntryIds: ids,
  };
}

export function listAchievedMilestones(db: Database): MilestoneRecord[] {
  return db
    .prepare("SELECT * FROM mission_milestones ORDER BY stage ASC")
    .all()
    .map(toRecord);
}

export function evaluateMilestones(
  db: Database,
  mission: MissionConfig,
  summary: LedgerSummary,
  now = new Date(),
): MilestoneStatus {
  const thresholds = mission.milestonesPence;
  const net = summary.netPence;
  const already = new Map(listAchievedMilestones(db).map((m) => [m.stage, m]));
  const evidence = listEffectiveLedgerEntries(db)
    .filter(isCountableRevenue)
    .map((e) => e.id);

  const newlyAchieved: MilestoneRecord[] = [];
  let currentStage = 0;

  thresholds.forEach((threshold, index) => {
    const stage = index + 1;
    if (net >= threshold) {
      currentStage = stage;
      if (!already.has(stage)) {
        const record: MilestoneRecord = {
          stage,
          thresholdPence: threshold,
          achievedAt: now.toISOString(),
          netPenceAtAchievement: net,
          evidenceEntryIds: evidence,
        };
        db.prepare(
          `INSERT OR IGNORE INTO mission_milestones
             (stage, threshold_pence, achieved_at, net_pence_at_achievement, evidence_entry_ids)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(stage, threshold, record.achievedAt, net, JSON.stringify(evidence));
        recordMissionEvent(db, "milestone", "system", `Stage ${stage} reached: net earnings ${net}p ≥ ${threshold}p`, {
          stage,
          thresholdPence: threshold,
          netPence: net,
          evidenceEntryIds: evidence,
        });
        newlyAchieved.push(record);
      }
    }
  });

  const nextIndex = thresholds.findIndex((t) => net < t);
  const target = mission.targetNetPence;
  const progress = target > 0 ? Math.max(0, Math.min(100, (net / target) * 100)) : 0;

  return {
    currentStage,
    nextStage: nextIndex === -1 ? null : nextIndex + 1,
    nextThresholdPence: nextIndex === -1 ? null : thresholds[nextIndex],
    achieved: listAchievedMilestones(db),
    newlyAchieved,
    progressToTargetPct: Math.round(progress * 10) / 10,
  };
}
