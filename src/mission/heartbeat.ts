/**
 * Mission review — deterministic daily heartbeat task.
 *
 * Uses no inference, so it costs nothing to run. Each run:
 *   1. records the mission start time on first run;
 *   2. expires stale approvals;
 *   3. evaluates milestones against the ledger;
 *   4. flags active opportunities that have produced no settled revenue
 *      within the configured window, so the agent reassesses them;
 *   5. records budget exhaustion once per day;
 *   6. writes the daily report to the reports directory (outside the repo);
 *   7. wakes the agent only if there is useful work it can afford to do,
 *      otherwise leaves it asleep in the low-cost state.
 */

import fs from "fs";
import path from "path";
import type BetterSqlite3 from "better-sqlite3";
import type { AutomatonConfig } from "../types.js";
import { getMissionConfig, isMissionEnabled } from "./config.js";
import { ensureMissionStarted } from "./budget.js";
import { expireStaleApprovals } from "./approvals.js";
import { buildMissionSnapshot, renderDailyReport } from "./report.js";
import { hasMissionEventSince, recordMissionEvent } from "./events.js";
import { getNextMissionTask } from "./tasks.js";
import { listOpportunities } from "./opportunities.js";
import { isCountableRevenue, listEffectiveLedgerEntries } from "./ledger.js";

type Database = BetterSqlite3.Database;

export const LAST_REVIEW_KEY = "mission.last_review_at";

function resolveHome(p: string): string {
  if (p.startsWith("~")) return path.join(process.env.HOME || "/root", p.slice(1));
  return p;
}

function startOfUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export interface MissionReviewResult {
  shouldWake: boolean;
  message?: string;
  reportPath?: string;
}

export async function runMissionReview(
  db: Database,
  config: AutomatonConfig,
  now = new Date(),
  options: { writeReport?: boolean } = {},
): Promise<MissionReviewResult> {
  if (!isMissionEnabled(config)) return { shouldWake: false };
  const mission = getMissionConfig(config);
  const today = startOfUtcDay(now);

  ensureMissionStarted(db, now);
  expireStaleApprovals(db, now);

  // Underperformance: active opportunities with no countable revenue in the window.
  const windowStart = new Date(now.getTime() - mission.underperformanceDays * 86_400_000).toISOString();
  const recentRevenue = listEffectiveLedgerEntries(db).filter(
    (e) => isCountableRevenue(e) && e.occurredAt >= windowStart,
  );
  for (const opp of listOpportunities(db, ["active"])) {
    const activeLongEnough = opp.updatedAt <= windowStart;
    const dedupKey = `reassess:${opp.id}`;
    if (activeLongEnough && recentRevenue.length === 0 && !hasMissionEventSince(db, "reassess", dedupKey, today)) {
      recordMissionEvent(
        db,
        "reassess",
        "system",
        `"${opp.name}" has been active for ${mission.underperformanceDays}+ days with no settled revenue. Analyse why and decide: change the offer, change the channel, or move to the next opportunity.`,
        { dedupKey, opportunityId: opp.id },
        now.toISOString(),
      );
    }
  }

  const snapshot = buildMissionSnapshot(db, config, now);

  const paidCompute = mission.computeFunding !== "free";
  const budgetExhausted =
    snapshot.budget.remainingCapitalPence <= 0 ||
    (paidCompute && snapshot.budget.computeRunwayPence <= 0);
  if (budgetExhausted && !hasMissionEventSince(db, "budget_exhausted", "daily", today)) {
    recordMissionEvent(
      db,
      "budget_exhausted",
      "system",
      "No compute runway or capital left. The agent stays asleep until the operator approves and records a top-up.",
      { dedupKey: "daily" },
      now.toISOString(),
    );
  }

  let reportPath: string | undefined;
  if (options.writeReport !== false) {
    const lastReview = db.prepare("SELECT value FROM kv WHERE key = ?").get(LAST_REVIEW_KEY) as
      | { value: string }
      | undefined;
    const since = lastReview?.value ?? snapshot.startedAt ?? today;
    const dir = resolveHome(mission.reportsDir);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      reportPath = path.join(dir, `${now.toISOString().slice(0, 10)}.md`);
      fs.writeFileSync(reportPath, renderDailyReport(db, snapshot, since), { mode: 0o600 });
    } catch {
      reportPath = undefined;
    }
  }

  db.prepare("INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(
    LAST_REVIEW_KEY,
    now.toISOString(),
  );
  recordMissionEvent(
    db,
    "review",
    "system",
    `Review: net ${snapshot.ledger.netPence}p, ${snapshot.openTasks.length} open tasks, ${snapshot.pendingApprovals.length} pending approvals`,
    { netPence: snapshot.ledger.netPence, reportPath: reportPath ?? null },
    now.toISOString(),
  );

  const next = getNextMissionTask(db);
  const canAffordWork = !paidCompute || snapshot.budget.computeRunwayPence > 0;
  if (next && canAffordWork) {
    return {
      shouldWake: true,
      message: `Mission review: next task "${next.title}"`,
      reportPath,
    };
  }
  return { shouldWake: false, reportPath };
}
