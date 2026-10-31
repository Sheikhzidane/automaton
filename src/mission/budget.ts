/**
 * Mission budget — authorised capital, committed spend and compute runway.
 *
 * Cash basis: a real-money purchase (prepaid API credit, a domain, a
 * payment fee) is an expense when it is approved and recorded. Inference
 * consumption then draws down the prepaid compute it bought, which gives
 * the compute runway. Earned revenue never raises the authorised capital
 * by itself; only a human capital grant does.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type { AutomatonConfig, SurvivalTier } from "../types.js";
import type { MissionBudgetState, MissionConfig } from "./types.js";
import { getMissionConfig, isMissionEnabled, usdCentsToPence } from "./config.js";
import { listEffectiveLedgerEntries, summariseLedger } from "./ledger.js";
import { recordMissionEvent } from "./events.js";

type Database = BetterSqlite3.Database;

/** Ledger categories that represent prepaid compute. */
export const COMPUTE_CATEGORIES = new Set(["compute_prepaid", "compute_credits"]);

export const MISSION_STARTED_KEY = "mission.started_at";

export function getMissionStartedAt(db: Database): string | null {
  try {
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(MISSION_STARTED_KEY) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export function ensureMissionStarted(db: Database, now = new Date()): string {
  const existing = getMissionStartedAt(db);
  if (existing) return existing;
  const iso = now.toISOString();
  db.prepare("INSERT OR IGNORE INTO kv (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(
    MISSION_STARTED_KEY,
    iso,
  );
  return getMissionStartedAt(db) ?? iso;
}

export function getGrantedCapitalPence(db: Database): number {
  const row = db
    .prepare("SELECT COALESCE(SUM(amount_pence), 0) AS total FROM mission_capital_grants")
    .get() as { total: number };
  return row.total;
}

export function grantCapital(
  db: Database,
  amountPence: number,
  reason: string,
): { id: string; amountPence: number } {
  if (!Number.isInteger(amountPence) || amountPence <= 0) {
    throw new Error("Capital grants must be a positive whole number of pence");
  }
  if (!reason?.trim()) throw new Error("A reason is required for a capital grant");
  const id = ulid();
  db.prepare(
    `INSERT INTO mission_capital_grants (id, amount_pence, reason, granted_by, granted_at)
     VALUES (?, ?, ?, 'human', ?)`,
  ).run(id, amountPence, reason.trim(), new Date().toISOString());
  recordMissionEvent(db, "capital_granted", "human", `Capital grant of ${amountPence}p: ${reason.trim()}`, {
    grantId: id,
    amountPence,
  });
  return { id, amountPence };
}

/** Inference consumption since the mission started, in USD cents. */
export function getComputeConsumedUsdCents(db: Database, sinceIso: string | null): number {
  try {
    const since = sinceIso ? sqliteDateTime(sinceIso) : "1970-01-01 00:00:00";
    const row = db
      .prepare(
        "SELECT COALESCE(SUM(cost_cents), 0) AS total FROM inference_costs WHERE created_at >= ?",
      )
      .get(since) as { total: number };
    return row.total;
  } catch {
    return 0;
  }
}

/** Average daily inference spend over the last `days` days, in USD cents. */
export function getAverageDailyComputeUsdCents(db: Database, days = 7, now = new Date()): number {
  try {
    const since = sqliteDateTime(new Date(now.getTime() - days * 86_400_000).toISOString());
    const row = db
      .prepare(
        "SELECT COALESCE(SUM(cost_cents), 0) AS total FROM inference_costs WHERE created_at >= ?",
      )
      .get(since) as { total: number };
    return row.total / days;
  } catch {
    return 0;
  }
}

export function getMissionBudgetState(
  db: Database,
  mission: MissionConfig,
): MissionBudgetState {
  const summary = summariseLedger(db);
  const granted = getGrantedCapitalPence(db);
  const authorised = mission.startingCapitalPence + granted;
  const committed = summary.expensesPence + summary.feesPence;

  const computePurchased = listEffectiveLedgerEntries(db)
    .filter((e) => e.entryType === "expense" && COMPUTE_CATEGORIES.has(e.category))
    .reduce((sum, e) => sum + e.amountPence, 0);
  const consumed = usdCentsToPence(
    getComputeConsumedUsdCents(db, getMissionStartedAt(db)),
    mission,
  );

  return {
    startingCapitalPence: mission.startingCapitalPence,
    grantedCapitalPence: granted,
    authorisedCapitalPence: authorised,
    committedSpendPence: committed,
    remainingCapitalPence: authorised - committed,
    computePurchasedPence: computePurchased,
    computeConsumedPence: consumed,
    computeRunwayPence: computePurchased - consumed,
  };
}

/**
 * Survival tier derived from the mission's compute runway. Mission mode
 * never uses the "high" tier, so expensive models are only reached through
 * the planning route.
 */
export function getMissionTier(
  state: MissionBudgetState,
  mission: MissionConfig,
): SurvivalTier {
  if (mission.computeFunding === "free") return "low_compute";
  if (state.computeRunwayPence <= 0) return "dead";
  const purchased = Math.max(state.computePurchasedPence, 1);
  const ratio = state.computeRunwayPence / purchased;
  if (ratio > 0.5) return "normal";
  if (ratio > 0.2) return "low_compute";
  return "critical";
}

const TIER_RANK: Record<SurvivalTier, number> = {
  dead: 0,
  critical: 1,
  low_compute: 2,
  normal: 3,
  high: 4,
};

/**
 * The tier the runtime should use, given the Conway credit tier.
 * Returns the credit tier unchanged when the mission is off.
 *  - byok / free: the mission tier replaces the Conway credit tier, which
 *    would otherwise read zero credits as "dying".
 *  - conway: the more restrictive of the two.
 */
export function resolveEffectiveTier(
  db: Database,
  config: AutomatonConfig,
  creditTier: SurvivalTier,
): SurvivalTier {
  if (!isMissionEnabled(config)) return creditTier;
  const mission = getMissionConfig(config);
  let missionTier: SurvivalTier;
  try {
    missionTier = getMissionTier(getMissionBudgetState(db, mission), mission);
  } catch {
    // Mission tables missing or unreadable: fail closed.
    return "critical";
  }
  if (mission.computeFunding === "conway") {
    return TIER_RANK[missionTier] < TIER_RANK[creditTier] ? missionTier : creditTier;
  }
  return missionTier;
}

/**
 * Whether a spend of `amountPence` fits inside the remaining authorised
 * capital. Used both when a human approves a spend and when the runtime is
 * about to execute it.
 */
export function checkSpendFits(
  db: Database,
  mission: MissionConfig,
  amountPence: number,
): { fits: boolean; remainingPence: number; reason?: string } {
  const state = getMissionBudgetState(db, mission);
  if (!Number.isInteger(amountPence) || amountPence < 0) {
    return { fits: false, remainingPence: state.remainingCapitalPence, reason: "Invalid amount" };
  }
  if (amountPence > state.remainingCapitalPence) {
    return {
      fits: false,
      remainingPence: state.remainingCapitalPence,
      reason: `Spend of ${amountPence}p exceeds remaining authorised capital of ${state.remainingCapitalPence}p`,
    };
  }
  return { fits: true, remainingPence: state.remainingCapitalPence };
}

function sqliteDateTime(iso: string): string {
  // inference_costs.created_at uses SQLite's datetime('now') format.
  return iso.replace("T", " ").replace(/\.\d+Z$/, "").replace(/Z$/, "");
}
