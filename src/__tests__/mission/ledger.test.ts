/**
 * Mission ledger: append-only storage and the counting rules for
 * "genuine net earnings".
 */

import { describe, it, expect, beforeEach } from "vitest";
import type BetterSqlite3 from "better-sqlite3";
import {
  appendLedgerEntry,
  LedgerValidationError,
  listEffectiveLedgerEntries,
  summariseLedger,
} from "../../mission/ledger.js";
import { newDb } from "./helpers.js";

let raw: BetterSqlite3.Database;

beforeEach(() => {
  raw = newDb().raw;
});

function revenue(overrides: Record<string, unknown> = {}) {
  return appendLedgerEntry(raw, {
    entryType: "revenue",
    status: "settled",
    amountPence: 5000,
    category: "readiness_review",
    description: "Inspection readiness review",
    evidenceRef: "pi_123",
    counterpartyRef: "CUST-001",
    recordedBy: "human",
    ...overrides,
  } as any);
}

describe("mission ledger storage", () => {
  it("rejects updates and deletes at the database level", () => {
    const entry = revenue();
    expect(() => raw.prepare("UPDATE mission_ledger SET amount_pence = 1 WHERE id = ?").run(entry.id)).toThrow(/append-only/);
    expect(() => raw.prepare("DELETE FROM mission_ledger WHERE id = ?").run(entry.id)).toThrow(/append-only/);
  });

  it("refuses entries recorded by the agent", () => {
    expect(() => revenue({ recordedBy: "agent" })).toThrow(LedgerValidationError);
  });

  it("requires evidence for settled revenue", () => {
    expect(() => revenue({ evidenceRef: undefined })).toThrow(/evidence/);
    expect(() => revenue({ evidenceRef: "   " })).toThrow(/evidence/);
  });

  it("allows pending revenue without evidence", () => {
    expect(() => revenue({ status: "pending", evidenceRef: undefined })).not.toThrow();
  });

  it("rejects non-positive or fractional amounts", () => {
    expect(() => revenue({ amountPence: 0 })).toThrow(/positive/);
    expect(() => revenue({ amountPence: -5 })).toThrow(/positive/);
    expect(() => revenue({ amountPence: 12.5 })).toThrow(/positive/);
  });

  it("keeps personal data out of counterparty references", () => {
    expect(() => revenue({ counterpartyRef: "owner@cafe.co.uk" })).toThrow(/pseudonymous/);
    expect(() => revenue({ counterpartyRef: "07700 900123" })).toThrow(/pseudonymous/);
  });
});

describe("mission ledger counting rules", () => {
  it("counts only settled, evidenced, attributable, non-related revenue", () => {
    revenue({ amountPence: 5000 });
    revenue({ amountPence: 60000, relatedParty: true, description: "Own restaurant" });
    revenue({ amountPence: 3000, attributable: false, description: "Sale the agent had no part in" });
    revenue({ amountPence: 9000, status: "pending", evidenceRef: undefined, description: "Invoice sent" });

    const s = summariseLedger(raw);
    expect(s.countableRevenuePence).toBe(5000);
    expect(s.excludedRevenuePence).toBe(63000);
    expect(s.pendingRevenuePence).toBe(9000);
    expect(s.outstandingInvoices).toBe(1);
    expect(s.confirmedPayments).toBe(1);
    expect(s.revenueByCategory).toEqual({ readiness_review: 5000 });
  });

  it("subtracts expenses, fees and refunds from net", () => {
    revenue({ amountPence: 10000 });
    appendLedgerEntry(raw, { entryType: "expense", status: "settled", amountPence: 800, category: "compute_prepaid", description: "API credit", recordedBy: "human" });
    appendLedgerEntry(raw, { entryType: "fee", status: "settled", amountPence: 170, category: "payment_fee", description: "Card fee", recordedBy: "human" });
    appendLedgerEntry(raw, { entryType: "refund", status: "settled", amountPence: 2000, category: "refund", description: "Partial refund", evidenceRef: "re_1", recordedBy: "human" });
    appendLedgerEntry(raw, { entryType: "expense", status: "pending", amountPence: 300, category: "domain", description: "Domain on order", recordedBy: "human" });

    const s = summariseLedger(raw);
    expect(s.expensesPence).toBe(1100);
    expect(s.feesPence).toBe(170);
    expect(s.refundsPence).toBe(2000);
    expect(s.netPence).toBe(10000 - 1100 - 170 - 2000);
  });

  it("applies corrections by superseding, never editing", () => {
    const pending = revenue({ status: "pending", evidenceRef: undefined });
    expect(summariseLedger(raw).countableRevenuePence).toBe(0);

    const settled = revenue({ supersedesId: pending.id });
    const s = summariseLedger(raw);
    expect(s.countableRevenuePence).toBe(5000);
    expect(s.pendingRevenuePence).toBe(0);
    expect(listEffectiveLedgerEntries(raw).map((e) => e.id)).toEqual([settled.id]);

    expect(() => revenue({ supersedesId: pending.id })).toThrow(/already been superseded/);
  });

  it("only lets a correction supersede an entry of the same type", () => {
    const expense = appendLedgerEntry(raw, { entryType: "expense", status: "settled", amountPence: 500, category: "x", description: "x", recordedBy: "human" });
    expect(() => revenue({ supersedesId: expense.id })).toThrow(/same entry type/);
  });
});
