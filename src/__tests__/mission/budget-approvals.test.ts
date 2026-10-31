/**
 * Mission budget (lifetime capital, compute runway, tiers) and approvals.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type BetterSqlite3 from "better-sqlite3";
import { appendLedgerEntry } from "../../mission/ledger.js";
import {
  checkSpendFits,
  ensureMissionStarted,
  getMissionBudgetState,
  getMissionTier,
  grantCapital,
  resolveEffectiveTier,
} from "../../mission/budget.js";
import {
  consumeApproval,
  decideApproval,
  expireStaleApprovals,
  findUsableApproval,
  hashToolArgs,
  MAX_PENDING_AGENT_APPROVALS,
  requestApproval,
} from "../../mission/approvals.js";
import { getMissionConfig, resolveMissionConfig, usdCentsToPence, formatPence } from "../../mission/config.js";
import { missionConfig, newDb, recordInferenceCost } from "./helpers.js";

let raw: BetterSqlite3.Database;
const config = missionConfig();
const mission = getMissionConfig(config);

beforeEach(() => {
  raw = newDb().raw;
});

function buyCompute(pence: number) {
  appendLedgerEntry(raw, {
    entryType: "expense",
    status: "settled",
    amountPence: pence,
    category: "compute_prepaid",
    description: "Prepaid API credit",
    evidenceRef: "receipt-1",
    recordedBy: "human",
  });
}

describe("mission config", () => {
  it("defaults to £20 capital and a £2,000 target with seven milestones", () => {
    const m = resolveMissionConfig({ enabled: true });
    expect(m.startingCapitalPence).toBe(2000);
    expect(m.targetNetPence).toBe(200000);
    expect(m.milestonesPence).toEqual([1000, 5000, 10000, 25000, 50000, 100000, 200000]);
  });

  it("falls back to safe defaults for invalid values instead of widening the budget", () => {
    const m = resolveMissionConfig({ enabled: true, startingCapitalPence: -1 as any, fx: { usdToGbp: 0, feeBufferPct: -3 } });
    expect(m.startingCapitalPence).toBe(2000);
    expect(m.fx.usdToGbp).toBeGreaterThan(0);
    expect(m.fx.feeBufferPct).toBeGreaterThanOrEqual(0);
  });

  it("converts USD cents to pence conservatively (rounds up, adds buffer)", () => {
    const m = resolveMissionConfig({ enabled: true, fx: { usdToGbp: 0.8, feeBufferPct: 3 } });
    expect(usdCentsToPence(500, m)).toBe(412); // $5 → £4.12 (4.00 + 3%)
    expect(usdCentsToPence(1, m)).toBe(1);
    expect(usdCentsToPence(0, m)).toBe(0);
  });

  it("formats pence as pounds", () => {
    expect(formatPence(200000)).toBe("£2,000.00");
    expect(formatPence(-150)).toBe("-£1.50");
  });
});

describe("mission budget", () => {
  it("treats the starting capital as a lifetime allowance", () => {
    buyCompute(1500);
    const state = getMissionBudgetState(raw, mission);
    expect(state.remainingCapitalPence).toBe(500);
    expect(checkSpendFits(raw, mission, 500).fits).toBe(true);
    expect(checkSpendFits(raw, mission, 501).fits).toBe(false);
  });

  it("does not let earned revenue raise authorised capital without a grant", () => {
    appendLedgerEntry(raw, { entryType: "revenue", status: "settled", amountPence: 50000, category: "service", description: "Paid", evidenceRef: "pi_1", recordedBy: "human" });
    expect(getMissionBudgetState(raw, mission).remainingCapitalPence).toBe(2000);

    grantCapital(raw, 3000, "Reinvest part of first revenue");
    expect(getMissionBudgetState(raw, mission).authorisedCapitalPence).toBe(5000);
    expect(() => raw.prepare("DELETE FROM mission_capital_grants").run()).toThrow(/append-only/);
  });

  it("derives compute runway from prepaid compute minus consumption", () => {
    ensureMissionStarted(raw, new Date(Date.now() - 60_000));
    buyCompute(800);
    recordInferenceCost(raw, 100); // $1.00 → 83p with defaults
    const state = getMissionBudgetState(raw, mission);
    expect(state.computePurchasedPence).toBe(800);
    expect(state.computeConsumedPence).toBe(usdCentsToPence(100, mission));
    expect(state.computeRunwayPence).toBe(800 - usdCentsToPence(100, mission));
  });

  it("maps runway to tiers and never uses the high tier", () => {
    const base = getMissionBudgetState(raw, mission);
    expect(getMissionTier({ ...base, computePurchasedPence: 0, computeRunwayPence: 0 }, mission)).toBe("dead");
    expect(getMissionTier({ ...base, computePurchasedPence: 1000, computeRunwayPence: 900 }, mission)).toBe("normal");
    expect(getMissionTier({ ...base, computePurchasedPence: 1000, computeRunwayPence: 300 }, mission)).toBe("low_compute");
    expect(getMissionTier({ ...base, computePurchasedPence: 1000, computeRunwayPence: 100 }, mission)).toBe("critical");
    expect(getMissionTier(base, resolveMissionConfig({ enabled: true, computeFunding: "free" }))).toBe("low_compute");
  });

  it("leaves the credit tier untouched when the mission is off", () => {
    const off = missionConfig({ enabled: false });
    expect(resolveEffectiveTier(raw, off, "high")).toBe("high");
  });

  it("uses the more restrictive tier when Conway pays for compute", () => {
    const conway = missionConfig({ computeFunding: "conway" });
    buyCompute(1000);
    expect(resolveEffectiveTier(raw, conway, "critical")).toBe("critical");
    expect(resolveEffectiveTier(raw, conway, "high")).toBe("normal");
  });
});

describe("mission approvals", () => {
  it("binds approvals to the exact tool arguments, independent of key order", () => {
    expect(hashToolArgs("t", { a: 1, b: { c: 2, d: 3 } })).toBe(hashToolArgs("t", { b: { d: 3, c: 2 }, a: 1 }));
    expect(hashToolArgs("t", { a: 1 })).not.toBe(hashToolArgs("t", { a: 2 }));
    expect(hashToolArgs("t", { a: 1 })).not.toBe(hashToolArgs("u", { a: 1 }));
  });

  it("deduplicates repeated requests for the same call", () => {
    const hash = hashToolArgs("topup_credits", { amount_usd: 5 });
    const a = requestApproval(raw, { kind: "spend", toolName: "topup_credits", argsHash: hash, summary: "top up", amountPence: 412, requestedBy: "agent" });
    const b = requestApproval(raw, { kind: "spend", toolName: "topup_credits", argsHash: hash, summary: "top up", amountPence: 412, requestedBy: "agent" });
    expect(b.id).toBe(a.id);
  });

  it("caps how many pending requests the agent can open", () => {
    for (let i = 0; i < MAX_PENDING_AGENT_APPROVALS; i++) {
      requestApproval(raw, { kind: "outreach", summary: `draft ${i}`, requestedBy: "agent" });
    }
    expect(() => requestApproval(raw, { kind: "outreach", summary: "one more", requestedBy: "agent" })).toThrow(/pending/);
  });

  it("only lets a human decide", () => {
    const a = requestApproval(raw, { kind: "outreach", summary: "email", requestedBy: "agent" });
    expect(() => decideApproval(raw, mission, a.id, { decision: "approved", decidedBy: "agent" as any })).toThrow(/human/);
  });

  it("refuses to approve a spend with no amount or above remaining capital", () => {
    const a = requestApproval(raw, { kind: "spend", summary: "domain", requestedBy: "agent" });
    expect(() => decideApproval(raw, mission, a.id, { decision: "approved", decidedBy: "human" })).toThrow(/amount/);
    expect(() => decideApproval(raw, mission, a.id, { decision: "approved", decidedBy: "human", amountPence: 2001 })).toThrow(/exceeds/);
    const ok = decideApproval(raw, mission, a.id, { decision: "approved", decidedBy: "human", amountPence: 999 });
    expect(ok.status).toBe("approved");
    expect(ok.amountPence).toBe(999);
  });

  it("can be used once, then is consumed", () => {
    const hash = hashToolArgs("register_domain", { domain: "example.co.uk" });
    const a = requestApproval(raw, { kind: "spend", toolName: "register_domain", argsHash: hash, summary: "domain", requestedBy: "agent" });
    decideApproval(raw, mission, a.id, { decision: "approved", decidedBy: "human", amountPence: 900 });
    expect(findUsableApproval(raw, "register_domain", hash)?.id).toBe(a.id);
    expect(consumeApproval(raw, a.id)).toBe(true);
    expect(consumeApproval(raw, a.id)).toBe(false);
    expect(findUsableApproval(raw, "register_domain", hash)).toBeNull();
  });

  it("expires stale approvals", () => {
    const a = requestApproval(raw, { kind: "outreach", summary: "email", requestedBy: "agent", ttlHours: 1 });
    expect(expireStaleApprovals(raw, new Date(Date.now() + 2 * 3_600_000))).toBe(1);
    expect(() => decideApproval(raw, mission, a.id, { decision: "approved", decidedBy: "human" })).toThrow(/expired/);
  });
});
