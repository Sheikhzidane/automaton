/**
 * Mission ledger — append-only GBP record of revenue and costs.
 *
 * Counting rules (the mission's definition of "genuine net earnings"):
 *   - Only settled revenue with an evidence reference counts.
 *   - Revenue from related parties (the operator's own businesses, employer,
 *     family) never counts, and neither does revenue the agent did not
 *     source or materially progress (attributable = false).
 *   - Pending revenue is shown separately as outstanding invoices.
 *   - Every expense and fee counts, settled or pending (conservative).
 *   - Corrections are new entries that supersede old ones; nothing is
 *     edited or deleted (enforced by database triggers).
 *   - The agent cannot record entries. Only the human operator (CLI) or
 *     the runtime itself (approved spends) can.
 */

import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";
import type {
  LedgerEntryInput,
  LedgerEntryRow,
  LedgerSummary,
} from "./types.js";
import { recordMissionEvent } from "./events.js";

type Database = BetterSqlite3.Database;

const EMAIL_LIKE = /@/;
const PHONE_LIKE = /\d[\d\s-]{6,}\d/;

export class LedgerValidationError extends Error {}

function validate(input: LedgerEntryInput): void {
  if (!Number.isInteger(input.amountPence) || input.amountPence <= 0) {
    throw new LedgerValidationError("amountPence must be a positive whole number of pence");
  }
  if (!["revenue", "expense", "refund", "fee"].includes(input.entryType)) {
    throw new LedgerValidationError(`Unknown entry type: ${input.entryType}`);
  }
  if (!["settled", "pending"].includes(input.status)) {
    throw new LedgerValidationError(`Unknown status: ${input.status}`);
  }
  if (input.recordedBy !== "human" && input.recordedBy !== "system") {
    throw new LedgerValidationError("Ledger entries can only be recorded by the human operator or the runtime");
  }
  if (!input.category?.trim()) {
    throw new LedgerValidationError("category is required");
  }
  if (!input.description?.trim()) {
    throw new LedgerValidationError("description is required");
  }
  if (input.entryType === "revenue" && input.status === "settled" && !input.evidenceRef?.trim()) {
    throw new LedgerValidationError(
      "Settled revenue needs an evidence reference (payment ID, payout ID or bank reference)",
    );
  }
  if (input.counterpartyRef && (EMAIL_LIKE.test(input.counterpartyRef) || PHONE_LIKE.test(input.counterpartyRef))) {
    throw new LedgerValidationError(
      "counterpartyRef must be a pseudonymous reference (e.g. CUST-004), not an email or phone number",
    );
  }
}

function toRow(r: any): LedgerEntryRow {
  return {
    id: r.id,
    entryType: r.entry_type,
    status: r.status,
    amountPence: r.amount_pence,
    category: r.category,
    description: r.description,
    counterpartyRef: r.counterparty_ref,
    evidenceRef: r.evidence_ref,
    originalCurrency: r.original_currency,
    originalAmountMinor: r.original_amount_minor,
    relatedParty: r.related_party === 1,
    attributable: r.attributable === 1,
    approvalId: r.approval_id,
    supersedesId: r.supersedes_id,
    recordedBy: r.recorded_by,
    occurredAt: r.occurred_at,
    createdAt: r.created_at,
  };
}

export function getLedgerEntry(db: Database, id: string): LedgerEntryRow | null {
  const row = db.prepare("SELECT * FROM mission_ledger WHERE id = ?").get(id);
  return row ? toRow(row) : null;
}

export function appendLedgerEntry(
  db: Database,
  input: LedgerEntryInput,
): LedgerEntryRow {
  validate(input);

  if (input.supersedesId) {
    const original = getLedgerEntry(db, input.supersedesId);
    if (!original) {
      throw new LedgerValidationError(`Cannot supersede unknown entry ${input.supersedesId}`);
    }
    if (original.entryType !== input.entryType) {
      throw new LedgerValidationError("A correction must have the same entry type as the entry it supersedes");
    }
    const alreadySuperseded = db
      .prepare("SELECT id FROM mission_ledger WHERE supersedes_id = ?")
      .get(input.supersedesId);
    if (alreadySuperseded) {
      throw new LedgerValidationError(`Entry ${input.supersedesId} has already been superseded`);
    }
  }

  const now = new Date().toISOString();
  const id = ulid();
  db.prepare(
    `INSERT INTO mission_ledger (
       id, entry_type, status, amount_pence, category, description,
       counterparty_ref, evidence_ref, original_currency, original_amount_minor,
       related_party, attributable, approval_id, supersedes_id, recorded_by,
       occurred_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.entryType,
    input.status,
    input.amountPence,
    input.category.trim(),
    input.description.trim(),
    input.counterpartyRef?.trim() || null,
    input.evidenceRef?.trim() || null,
    input.originalCurrency ?? null,
    input.originalAmountMinor ?? null,
    input.relatedParty ? 1 : 0,
    input.attributable === false ? 0 : 1,
    input.approvalId ?? null,
    input.supersedesId ?? null,
    input.recordedBy,
    input.occurredAt ?? now,
    now,
  );

  recordMissionEvent(db, "ledger_entry", input.recordedBy, `${input.entryType} ${input.status} ${input.amountPence}p: ${input.description.slice(0, 120)}`, {
    entryId: id,
    entryType: input.entryType,
    status: input.status,
    amountPence: input.amountPence,
    supersedesId: input.supersedesId ?? null,
  });

  return getLedgerEntry(db, id)!;
}

/** Entries that have not been superseded by a later correction. */
export function listEffectiveLedgerEntries(db: Database): LedgerEntryRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM mission_ledger l
       WHERE NOT EXISTS (SELECT 1 FROM mission_ledger c WHERE c.supersedes_id = l.id)
       ORDER BY occurred_at ASC, id ASC`,
    )
    .all();
  return rows.map(toRow);
}

export function listAllLedgerEntries(db: Database, limit = 200): LedgerEntryRow[] {
  const rows = db
    .prepare(`SELECT * FROM mission_ledger ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(Math.max(1, Math.min(limit, 5000)));
  return rows.map(toRow);
}

export function isCountableRevenue(entry: LedgerEntryRow): boolean {
  return (
    entry.entryType === "revenue" &&
    entry.status === "settled" &&
    !entry.relatedParty &&
    entry.attributable &&
    !!entry.evidenceRef
  );
}

export function summariseLedger(db: Database): LedgerSummary {
  const entries = listEffectiveLedgerEntries(db);
  const summary: LedgerSummary = {
    settledRevenuePence: 0,
    countableRevenuePence: 0,
    excludedRevenuePence: 0,
    pendingRevenuePence: 0,
    refundsPence: 0,
    expensesPence: 0,
    feesPence: 0,
    netPence: 0,
    confirmedPayments: 0,
    outstandingInvoices: 0,
    revenueByCategory: {},
  };

  for (const e of entries) {
    switch (e.entryType) {
      case "revenue":
        if (e.status === "pending") {
          summary.pendingRevenuePence += e.amountPence;
          summary.outstandingInvoices += 1;
          break;
        }
        summary.settledRevenuePence += e.amountPence;
        if (isCountableRevenue(e)) {
          summary.countableRevenuePence += e.amountPence;
          summary.confirmedPayments += 1;
          summary.revenueByCategory[e.category] =
            (summary.revenueByCategory[e.category] ?? 0) + e.amountPence;
        } else {
          summary.excludedRevenuePence += e.amountPence;
        }
        break;
      case "refund":
        summary.refundsPence += e.amountPence;
        break;
      case "expense":
        summary.expensesPence += e.amountPence;
        break;
      case "fee":
        summary.feesPence += e.amountPence;
        break;
    }
  }

  summary.netPence =
    summary.countableRevenuePence -
    summary.refundsPence -
    summary.expensesPence -
    summary.feesPence;
  return summary;
}
