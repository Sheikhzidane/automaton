/**
 * Mission snapshot and reports.
 *
 * One snapshot feeds three renderers: the operator's CLI status, the daily
 * markdown report, and the compact section injected into the agent's
 * system prompt on every turn (state restoration after context loss).
 * Figures come only from the ledger and the database — never from the
 * model's own claims.
 */

import type BetterSqlite3 from "better-sqlite3";
import type { AutomatonConfig } from "../types.js";
import type {
  ApprovalRow,
  LedgerSummary,
  MissionBudgetState,
  MissionConfig,
  MissionTaskRow,
  OpportunityRow,
} from "./types.js";
import { formatPence, getMissionConfig, usdCentsToPence } from "./config.js";
import { summariseLedger } from "./ledger.js";
import {
  getAverageDailyComputeUsdCents,
  getMissionBudgetState,
  getMissionStartedAt,
  getMissionTier,
} from "./budget.js";
import { evaluateMilestones, type MilestoneStatus } from "./milestones.js";
import { listApprovals } from "./approvals.js";
import { countTasksCompletedSince, getCheckpoint, listMissionTasks, type MissionCheckpoint } from "./tasks.js";
import { listOpportunities } from "./opportunities.js";
import { listMissionEvents, type MissionEventRow } from "./events.js";

type Database = BetterSqlite3.Database;

export interface MissionSnapshot {
  generatedAt: string;
  startedAt: string | null;
  mission: Pick<MissionConfig, "name" | "objective" | "startingCapitalPence" | "targetNetPence" | "computeFunding" | "spendControlsVerified">;
  budget: MissionBudgetState;
  ledger: LedgerSummary;
  milestones: MilestoneStatus;
  totalStages: number;
  tier: string;
  runwayDays: number | null;
  inferenceModel: string;
  openTasks: MissionTaskRow[];
  completedTaskCount: number;
  pendingApprovals: ApprovalRow[];
  opportunities: OpportunityRow[];
  currentBusinessModel: string | null;
  checkpoint: MissionCheckpoint | null;
  recentLessons: MissionEventRow[];
  attention: string[];
}

export function buildMissionSnapshot(
  db: Database,
  config: AutomatonConfig,
  now = new Date(),
): MissionSnapshot {
  const mission = getMissionConfig(config);
  const ledger = summariseLedger(db);
  const budget = getMissionBudgetState(db, mission);
  const milestones = evaluateMilestones(db, mission, ledger, now);
  const tier = getMissionTier(budget, mission);

  const avgDailyPence = usdCentsToPence(getAverageDailyComputeUsdCents(db, 7, now), mission);
  const runwayDays =
    mission.computeFunding === "free"
      ? null
      : avgDailyPence > 0
        ? Math.max(0, Math.floor(budget.computeRunwayPence / avgDailyPence))
        : null;

  const opportunities = listOpportunities(db);
  const active = opportunities.find((o) => o.status === "active") ?? null;
  const completed = db
    .prepare("SELECT COUNT(*) AS n FROM mission_tasks WHERE status = 'done'")
    .get() as { n: number };

  const attention: string[] = [];
  if (budget.remainingCapitalPence <= 0) {
    attention.push("Authorised capital is fully committed. Further spending needs a capital grant.");
  }
  if (mission.computeFunding !== "free" && budget.computePurchasedPence === 0) {
    attention.push("No prepaid compute recorded yet. The agent cannot use paid models until a top-up is approved and recorded.");
  } else if (mission.computeFunding !== "free" && budget.computeRunwayPence <= 0) {
    attention.push("Compute runway is used up. The agent stays asleep until compute is topped up.");
  }
  if (!mission.spendControlsVerified) {
    attention.push("Spending controls not yet verified. Run `automaton --mission verify-controls` before funding.");
  }
  try {
    const failing = db
      .prepare(
        "SELECT task_name, last_error FROM heartbeat_schedule WHERE last_result IN ('failure','timeout')",
      )
      .all() as Array<{ task_name: string; last_error: string | null }>;
    for (const f of failing) {
      attention.push(`Heartbeat task ${f.task_name} failed: ${(f.last_error ?? "unknown error").slice(0, 160)}`);
    }
  } catch {
    // heartbeat tables absent in minimal databases
  }
  const staleBlocked = listMissionTasks(db, { statuses: ["blocked"], limit: 50 }).filter(
    (t) => now.getTime() - new Date(t.updatedAt).getTime() > 7 * 86_400_000,
  );
  for (const t of staleBlocked) {
    attention.push(`Task blocked for over a week: ${t.title}`);
  }

  return {
    generatedAt: now.toISOString(),
    startedAt: getMissionStartedAt(db),
    mission: {
      name: mission.name,
      objective: mission.objective,
      startingCapitalPence: mission.startingCapitalPence,
      targetNetPence: mission.targetNetPence,
      computeFunding: mission.computeFunding,
      spendControlsVerified: mission.spendControlsVerified,
    },
    budget,
    ledger,
    milestones,
    totalStages: mission.milestonesPence.length,
    tier,
    runwayDays,
    inferenceModel: config.inferenceModel,
    openTasks: listMissionTasks(db, { limit: 20 }),
    completedTaskCount: completed.n,
    pendingApprovals: listApprovals(db, ["pending"]),
    opportunities: opportunities.slice(0, 10),
    currentBusinessModel: active ? `${active.name} (${active.modelType})` : null,
    checkpoint: getCheckpoint(db),
    recentLessons: listMissionEvents(db, { types: ["lesson"], limit: 5 }),
    attention,
  };
}

function stageLabel(s: MissionSnapshot): string {
  const m = s.milestones;
  const next =
    m.nextThresholdPence !== null
      ? `next: stage ${m.nextStage} at ${formatPence(m.nextThresholdPence)}`
      : "all stages reached";
  return `Stage ${m.currentStage} of ${s.totalStages} (${next})`;
}

export function renderMissionStatus(s: MissionSnapshot): string {
  const b = s.budget;
  const l = s.ledger;
  const lines: string[] = [];
  lines.push(`=== MISSION: ${s.mission.name} ===`);
  lines.push(`Generated:            ${s.generatedAt}`);
  lines.push(`Started:              ${s.startedAt ?? "not started"}`);
  lines.push("");
  lines.push(`Initial capital:      ${formatPence(b.startingCapitalPence)}`);
  lines.push(`Capital grants:       ${formatPence(b.grantedCapitalPence)}`);
  lines.push(`Remaining capital:    ${formatPence(b.remainingCapitalPence)}`);
  lines.push(`Revenue received:     ${formatPence(l.countableRevenuePence)} (${l.confirmedPayments} confirmed payments)`);
  lines.push(`Excluded revenue:     ${formatPence(l.excludedRevenuePence)} (related party, unattributed or unevidenced)`);
  lines.push(`Outstanding invoices: ${formatPence(l.pendingRevenuePence)} (${l.outstandingInvoices}, not counted)`);
  lines.push(`Operating costs:      ${formatPence(l.expensesPence + l.feesPence + l.refundsPence)}`);
  lines.push(`Net earnings:         ${formatPence(l.netPence)}`);
  lines.push(`Progress:             ${s.milestones.progressToTargetPct}% of ${formatPence(s.mission.targetNetPence)} — ${stageLabel(s)}`);
  lines.push(`Compute runway:       ${formatPence(b.computeRunwayPence)}${s.runwayDays !== null ? ` (~${s.runwayDays} days)` : ""} · tier ${s.tier} · ${s.mission.computeFunding}`);
  lines.push(`Business model:       ${s.currentBusinessModel ?? "none active"}`);
  lines.push("");
  if (Object.keys(l.revenueByCategory).length > 0) {
    lines.push("Revenue by product/service:");
    for (const [cat, pence] of Object.entries(l.revenueByCategory)) {
      lines.push(`  - ${cat}: ${formatPence(pence)}`);
    }
    lines.push("");
  }
  lines.push(`Next action:          ${s.checkpoint?.nextAction ?? "none recorded"}`);
  lines.push(`Active tasks (${s.openTasks.length}), completed ${s.completedTaskCount}:`);
  for (const t of s.openTasks.slice(0, 10)) {
    lines.push(`  [${t.status}] p${t.priority} ${t.stage}: ${t.title}${t.nextAction ? ` → ${t.nextAction}` : ""}`);
  }
  lines.push(`Pending approvals (${s.pendingApprovals.length}):`);
  for (const a of s.pendingApprovals.slice(0, 10)) {
    lines.push(`  ${a.id} [${a.kind}] ${a.amountPence > 0 ? formatPence(a.amountPence) + " " : ""}${a.summary.slice(0, 100)}`);
  }
  if (s.attention.length > 0) {
    lines.push("Needs attention:");
    for (const item of s.attention) lines.push(`  ! ${item}`);
  }
  lines.push("========================");
  return lines.join("\n");
}

/**
 * Compact mission block for the system prompt. Kept short: it is sent on
 * every turn and costs tokens.
 */
export function renderPromptSection(s: MissionSnapshot): string {
  const b = s.budget;
  const l = s.ledger;
  const tasks = s.openTasks
    .slice(0, 5)
    .map((t) => `- [${t.status}] (${t.id.slice(-6)}) ${t.stage}: ${t.title}${t.nextAction ? ` → ${t.nextAction}` : ""}`)
    .join("\n");
  const lessons = s.recentLessons
    .slice(0, 3)
    .map((e) => `- ${e.summary.slice(0, 160)}`)
    .join("\n");
  return `--- COMMERCIAL MISSION ---
Objective: ${s.mission.objective}
Net earnings: ${formatPence(l.netPence)} of ${formatPence(s.mission.targetNetPence)} (${s.milestones.progressToTargetPct}%). Confirmed payments: ${l.confirmedPayments}. Outstanding invoices: ${l.outstandingInvoices}.
Capital: ${formatPence(b.remainingCapitalPence)} remaining of ${formatPence(b.authorisedCapitalPence)}. Compute runway: ${formatPence(b.computeRunwayPence)}.
Current model: ${s.currentBusinessModel ?? "none active"}
Next action: ${s.checkpoint?.nextAction ?? "none — set one with mission_checkpoint"}
Open tasks:
${tasks || "- none"}
Pending approvals: ${s.pendingApprovals.length}${lessons ? `\nRecent lessons:\n${lessons}` : ""}
Rules (enforced by the runtime, not optional):
- You cannot spend money, contact anyone, publish, sign up for anything or make commitments without an approved request. Use mission_request_approval and continue with other work.
- Revenue counts only when the operator records a settled payment. Never claim or estimate revenue as earned.
- Keep tasks and the checkpoint current. Record what worked and what failed with mission_log_lesson.
- If there is no useful work, sleep instead of spending compute.
--- END COMMERCIAL MISSION ---`;
}

export function renderDailyReport(
  db: Database,
  s: MissionSnapshot,
  sinceIso: string,
): string {
  const completed = countTasksCompletedSince(db, sinceIso);
  const newOpps = listMissionEvents(db, { types: ["opportunity"], since: sinceIso, limit: 20 });
  const ledgerEvents = listMissionEvents(db, { types: ["ledger_entry"], since: sinceIso, limit: 50 });
  const lessons = listMissionEvents(db, { types: ["lesson"], since: sinceIso, limit: 20 });
  const blockers = [
    ...s.openTasks
      .filter((t) => t.status === "blocked" || t.status === "awaiting_approval")
      .map((t) => `${t.title} — ${t.blockedReason ?? t.status}`),
    ...s.pendingApprovals.map((a) => `Approval needed (${a.id}): ${a.summary.slice(0, 120)}`),
    ...s.attention,
  ];
  const next = s.openTasks
    .filter((t) => t.status === "queued" || t.status === "in_progress")
    .slice(0, 5);

  const list = (items: string[], empty: string) =>
    items.length > 0 ? items.map((i) => `- ${i}`).join("\n") : `- ${empty}`;

  return `# Mission report — ${s.generatedAt.slice(0, 10)}

Period: since ${sinceIso}

## Money
- Revenue genuinely earned (settled, counted): ${formatPence(s.ledger.countableRevenuePence)}
- Outstanding invoices (not counted): ${formatPence(s.ledger.pendingRevenuePence)}
- Money spent to date: ${formatPence(s.budget.committedSpendPence)}
- Net earnings: ${formatPence(s.ledger.netPence)} (${s.milestones.progressToTargetPct}% of ${formatPence(s.mission.targetNetPence)})
- Remaining authorised capital: ${formatPence(s.budget.remainingCapitalPence)}
- Compute runway: ${formatPence(s.budget.computeRunwayPence)}${s.runwayDays !== null ? ` (~${s.runwayDays} days)` : ""}

## Ledger entries this period
${list(ledgerEvents.map((e) => e.summary), "none")}

## Work completed
${list(completed.map((t) => `${t.title}${t.result ? ` — ${t.result}` : ""}`), "none")}

## Opportunities
${list(newOpps.map((e) => e.summary), "no changes")}

## Lessons
${list(lessons.map((e) => e.summary), "none recorded")}

## Blockers
${list(blockers, "none")}

## Next actions
${list(
    [
      ...(s.checkpoint ? [`Checkpoint: ${s.checkpoint.nextAction}`] : []),
      ...next.map((t) => `${t.title}${t.nextAction ? ` → ${t.nextAction}` : ""}`),
    ],
    "none queued",
  )}
`;
}
