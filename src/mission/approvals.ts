/**
 * Mission approvals.
 *
 * The agent can only REQUEST approvals. Decisions are made by the human
 * operator through the CLI (which requires an interactive terminal), never
 * through an agent tool. Spend approvals are checked against the remaining
 * authorised capital both when approved and when executed.
 *
 * An approval is bound to one tool and the exact arguments it was
 * requested with (SHA-256 of canonical JSON), so approving "top up £5" can
 * never be reused for a different call.
 */

import type BetterSqlite3 from "better-sqlite3";
import { createHash } from "crypto";
import { ulid } from "ulid";
import type { ApprovalKind, ApprovalRow, ApprovalStatus, MissionConfig } from "./types.js";
import { recordMissionEvent } from "./events.js";
import { checkSpendFits } from "./budget.js";

type Database = BetterSqlite3.Database;

export const DEFAULT_APPROVAL_TTL_HOURS = 72;
export const MAX_PENDING_AGENT_APPROVALS = 10;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

export function hashToolArgs(toolName: string, args: Record<string, unknown>): string {
  return createHash("sha256").update(`${toolName}\n${canonicalJson(args)}`).digest("hex");
}

function toRow(r: any): ApprovalRow {
  return {
    id: r.id,
    kind: r.kind,
    toolName: r.tool_name,
    summary: r.summary,
    amountPence: r.amount_pence,
    argsHash: r.args_hash,
    status: r.status,
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    decisionNote: r.decision_note,
    consumedAt: r.consumed_at,
    expiresAt: r.expires_at,
  };
}

export function getApproval(db: Database, id: string): ApprovalRow | null {
  const row = db.prepare("SELECT * FROM mission_approvals WHERE id = ?").get(id);
  return row ? toRow(row) : null;
}

/** Find an approval by full ID or by a unique suffix of at least 6 characters. */
export function findApprovalByRef(db: Database, ref: string): ApprovalRow | null {
  const exact = getApproval(db, ref);
  if (exact) return exact;
  if (ref.length < 6) return null;
  const rows = db
    .prepare("SELECT * FROM mission_approvals WHERE id LIKE ?")
    .all(`%${ref.toUpperCase()}`);
  return rows.length === 1 ? toRow(rows[0]) : null;
}

export function listApprovals(db: Database, statuses?: ApprovalStatus[]): ApprovalRow[] {
  if (statuses && statuses.length > 0) {
    const rows = db
      .prepare(
        `SELECT * FROM mission_approvals WHERE status IN (${statuses.map(() => "?").join(",")})
         ORDER BY requested_at DESC`,
      )
      .all(...statuses);
    return rows.map(toRow);
  }
  return db
    .prepare("SELECT * FROM mission_approvals ORDER BY requested_at DESC LIMIT 200")
    .all()
    .map(toRow);
}

export interface ApprovalRequestInput {
  kind: ApprovalKind;
  summary: string;
  amountPence?: number;
  toolName?: string;
  argsHash?: string;
  requestedBy: "agent" | "human" | "system";
  ttlHours?: number;
}

/**
 * Create a pending approval, or return the existing pending one for the
 * same tool call so repeated attempts do not flood the queue.
 */
export function requestApproval(db: Database, input: ApprovalRequestInput): ApprovalRow {
  const summary = input.summary?.trim();
  if (!summary) throw new Error("An approval request needs a summary");
  const amount = input.amountPence ?? 0;
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error("amountPence must be a non-negative whole number");
  }

  if (input.toolName && input.argsHash) {
    const existing = db
      .prepare(
        `SELECT * FROM mission_approvals
         WHERE tool_name = ? AND args_hash = ? AND status = 'pending'
         ORDER BY requested_at DESC LIMIT 1`,
      )
      .get(input.toolName, input.argsHash);
    if (existing) return toRow(existing);
  }

  if (input.requestedBy === "agent") {
    const pending = db
      .prepare(
        "SELECT COUNT(*) AS n FROM mission_approvals WHERE status = 'pending' AND requested_by = 'agent'",
      )
      .get() as { n: number };
    if (pending.n >= MAX_PENDING_AGENT_APPROVALS) {
      throw new Error(
        `There are already ${pending.n} pending approval requests. Wait for the operator to review them.`,
      );
    }
  }

  const now = new Date();
  const ttl = input.ttlHours ?? DEFAULT_APPROVAL_TTL_HOURS;
  const id = ulid();
  db.prepare(
    `INSERT INTO mission_approvals (
       id, kind, tool_name, summary, amount_pence, args_hash, status,
       requested_by, requested_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    id,
    input.kind,
    input.toolName ?? null,
    summary.slice(0, 1000),
    amount,
    input.argsHash ?? null,
    input.requestedBy,
    now.toISOString(),
    new Date(now.getTime() + ttl * 3_600_000).toISOString(),
  );

  recordMissionEvent(db, "approval_requested", input.requestedBy, summary.slice(0, 300), {
    approvalId: id,
    kind: input.kind,
    toolName: input.toolName ?? null,
    amountPence: amount,
  });

  return getApproval(db, id)!;
}

export interface ApprovalDecision {
  decision: "approved" | "rejected";
  decidedBy: "human";
  note?: string;
  /** Lets the operator set the approved amount for spends priced at execution time. */
  amountPence?: number;
}

/**
 * Record a human decision. Spend and capital approvals are checked against
 * the remaining authorised capital before they can be approved.
 */
export function decideApproval(
  db: Database,
  mission: MissionConfig,
  id: string,
  decision: ApprovalDecision,
  now = new Date(),
): ApprovalRow {
  if (decision.decidedBy !== "human") {
    throw new Error("Only the human operator can decide approvals");
  }
  const approval = getApproval(db, id);
  if (!approval) throw new Error(`Unknown approval ${id}`);
  if (approval.status !== "pending") {
    throw new Error(`Approval ${id} is ${approval.status}, not pending`);
  }
  if (approval.expiresAt && new Date(approval.expiresAt) <= now) {
    db.prepare("UPDATE mission_approvals SET status = 'expired' WHERE id = ?").run(id);
    throw new Error(`Approval ${id} has expired; ask the agent to request it again`);
  }

  let amount = approval.amountPence;
  if (decision.amountPence !== undefined) {
    if (!Number.isInteger(decision.amountPence) || decision.amountPence < 0) {
      throw new Error("amountPence must be a non-negative whole number");
    }
    amount = decision.amountPence;
  }

  if (decision.decision === "approved" && approval.kind === "spend") {
    if (amount <= 0) {
      throw new Error("A spend approval needs an amount. Pass the maximum you authorise in pence.");
    }
    const fits = checkSpendFits(db, mission, amount);
    if (!fits.fits) throw new Error(fits.reason);
  }

  db.prepare(
    `UPDATE mission_approvals
     SET status = ?, decided_at = ?, decided_by = 'human', decision_note = ?, amount_pence = ?
     WHERE id = ? AND status = 'pending'`,
  ).run(decision.decision, now.toISOString(), decision.note ?? null, amount, id);

  recordMissionEvent(db, "approval_decided", "human", `${decision.decision}: ${approval.summary.slice(0, 200)}`, {
    approvalId: id,
    decision: decision.decision,
    amountPence: amount,
  });

  return getApproval(db, id)!;
}

/** An approved, unexpired, unconsumed approval for this exact tool call. */
export function findUsableApproval(
  db: Database,
  toolName: string,
  argsHash: string,
  now = new Date(),
): ApprovalRow | null {
  const row = db
    .prepare(
      `SELECT * FROM mission_approvals
       WHERE tool_name = ? AND args_hash = ? AND status = 'approved'
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY decided_at DESC LIMIT 1`,
    )
    .get(toolName, argsHash, now.toISOString());
  return row ? toRow(row) : null;
}

export function consumeApproval(db: Database, id: string, now = new Date()): boolean {
  const result = db
    .prepare(
      `UPDATE mission_approvals SET status = 'consumed', consumed_at = ?
       WHERE id = ? AND status = 'approved'`,
    )
    .run(now.toISOString(), id);
  if (result.changes === 1) {
    recordMissionEvent(db, "approval_consumed", "system", `Approval ${id} used`, { approvalId: id });
    return true;
  }
  return false;
}

export function expireStaleApprovals(db: Database, now = new Date()): number {
  const result = db
    .prepare(
      `UPDATE mission_approvals SET status = 'expired'
       WHERE status IN ('pending','approved') AND expires_at IS NOT NULL AND expires_at <= ?`,
    )
    .run(now.toISOString());
  return result.changes;
}
