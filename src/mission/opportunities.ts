/**
 * Commercial opportunity evaluation.
 *
 * Opportunities are scored 0–100 from eight criteria (each rated 0–5) with
 * a hard legal-and-ethical gate. Weights favour evidence of demand and a
 * fast path to the first paying customer, then whether the target is
 * reachable with few customers, then reuse of existing work, because the
 * mission starts with almost no capital and limited operator time.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type { OpportunityCriteria, OpportunityRow, OpportunityStatus } from "./types.js";
import { recordMissionEvent } from "./events.js";

type Database = BetterSqlite3.Database;

export const OPPORTUNITY_WEIGHTS: Record<
  Exclude<keyof OpportunityCriteria, "legalAndEthical">,
  number
> = {
  demandEvidence: 0.25,
  timeToFirstCustomer: 0.2,
  revenuePotential: 0.15,
  deliverability: 0.1,
  assetReuse: 0.1,
  startupCost: 0.1,
  margin: 0.05,
  lowMaintenance: 0.05,
};

export interface OpportunityScore {
  score: number;
  rejected: boolean;
  reason?: string;
}

export function validateCriteria(criteria: OpportunityCriteria): void {
  for (const key of Object.keys(OPPORTUNITY_WEIGHTS) as Array<keyof typeof OPPORTUNITY_WEIGHTS>) {
    const value = criteria[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 5) {
      throw new Error(`Criterion ${key} must be a number from 0 to 5`);
    }
  }
  if (typeof criteria.legalAndEthical !== "boolean") {
    throw new Error("legalAndEthical must be true or false");
  }
}

export function scoreOpportunity(criteria: OpportunityCriteria): OpportunityScore {
  validateCriteria(criteria);
  if (!criteria.legalAndEthical) {
    return { score: 0, rejected: true, reason: "Fails the legal and ethical gate" };
  }
  let total = 0;
  for (const [key, weight] of Object.entries(OPPORTUNITY_WEIGHTS)) {
    total += (criteria[key as keyof typeof OPPORTUNITY_WEIGHTS] / 5) * weight;
  }
  return { score: Math.round(total * 1000) / 10, rejected: false };
}

function toRow(r: any): OpportunityRow {
  return {
    id: r.id,
    name: r.name,
    modelType: r.model_type,
    status: r.status,
    criteria: JSON.parse(r.criteria),
    score: r.score,
    rejectionReason: r.rejection_reason,
    evidence: r.evidence,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function upsertOpportunity(
  db: Database,
  input: {
    name: string;
    modelType: string;
    criteria: OpportunityCriteria;
    evidence?: string;
    status?: OpportunityStatus;
  },
  actor: "agent" | "human" = "agent",
): OpportunityRow {
  const name = input.name?.trim();
  if (!name) throw new Error("An opportunity needs a name");
  const scored = scoreOpportunity(input.criteria);
  const now = new Date().toISOString();
  const status: OpportunityStatus = scored.rejected ? "rejected" : input.status ?? "candidate";
  const existing = db.prepare("SELECT id FROM mission_opportunities WHERE name = ?").get(name) as
    | { id: string }
    | undefined;

  if (existing) {
    db.prepare(
      `UPDATE mission_opportunities
       SET model_type = ?, criteria = ?, score = ?, status = ?, rejection_reason = ?,
           evidence = COALESCE(?, evidence), updated_at = ?
       WHERE id = ?`,
    ).run(
      input.modelType,
      JSON.stringify(input.criteria),
      scored.score,
      status,
      scored.reason ?? null,
      input.evidence ?? null,
      now,
      existing.id,
    );
  } else {
    db.prepare(
      `INSERT INTO mission_opportunities
         (id, name, model_type, status, criteria, score, rejection_reason, evidence, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ulid(),
      name,
      input.modelType,
      status,
      JSON.stringify(input.criteria),
      scored.score,
      scored.reason ?? null,
      input.evidence ?? null,
      now,
      now,
    );
  }

  recordMissionEvent(db, "opportunity", actor, `${name}: score ${scored.score}${scored.rejected ? " (rejected)" : ""}`, {
    name,
    score: scored.score,
    status,
  });

  return toRow(db.prepare("SELECT * FROM mission_opportunities WHERE name = ?").get(name));
}

export function setOpportunityStatus(
  db: Database,
  idOrName: string,
  status: OpportunityStatus,
  reason?: string,
  actor: "agent" | "human" = "agent",
): OpportunityRow {
  const row = db
    .prepare("SELECT * FROM mission_opportunities WHERE id = ? OR name = ?")
    .get(idOrName, idOrName);
  if (!row) throw new Error(`Unknown opportunity ${idOrName}`);
  const current = toRow(row);
  if (current.rejectionReason === "Fails the legal and ethical gate" && status !== "rejected") {
    throw new Error("An opportunity that failed the legal and ethical gate cannot be reactivated");
  }
  db.prepare(
    `UPDATE mission_opportunities SET status = ?, rejection_reason = COALESCE(?, rejection_reason), updated_at = ?
     WHERE id = ?`,
  ).run(status, reason ?? null, new Date().toISOString(), current.id);
  recordMissionEvent(db, "opportunity", actor, `${current.name} → ${status}${reason ? `: ${reason}` : ""}`, {
    opportunityId: current.id,
    status,
  });
  return toRow(db.prepare("SELECT * FROM mission_opportunities WHERE id = ?").get(current.id));
}

export function listOpportunities(db: Database, statuses?: OpportunityStatus[]): OpportunityRow[] {
  const rows =
    statuses && statuses.length > 0
      ? db
          .prepare(
            `SELECT * FROM mission_opportunities WHERE status IN (${statuses.map(() => "?").join(",")})
             ORDER BY score DESC, updated_at DESC`,
          )
          .all(...statuses)
      : db.prepare("SELECT * FROM mission_opportunities ORDER BY score DESC, updated_at DESC").all();
  return rows.map(toRow);
}
