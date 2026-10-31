// The mission ledger: every pound in and out, append-only and
// hash-chained so an edited or deleted line is detected on the next run.
//
// Only genuine mission earnings count towards the target: settled, with
// payment evidence, not from a related party (your own businesses,
// employer, family), not a test, and attributable to mission activity.
// Corrections never edit a line; they add one that supersedes it.

import { appendJsonl, readJsonl, sha256, looksPersonal } from './util.mjs';

export const LEDGER_TYPES = ['revenue', 'refund', 'expense', 'correction'];
const GENESIS = '0'.repeat(64);

function canonical(entry) {
  const { hash, ...rest } = entry;
  const keys = Object.keys(rest).sort();
  return JSON.stringify(keys.map((k) => [k, rest[k]]));
}

export function verifyChain(entries) {
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq !== i + 1) return { ok: false, error: `Line ${i + 1}: sequence ${e.seq}, expected ${i + 1}` };
    if (e.prevHash !== prev) return { ok: false, error: `Line ${i + 1}: previous hash does not match (a line was removed, added or changed above it)` };
    if (sha256(canonical(e)) !== e.hash) return { ok: false, error: `Line ${i + 1}: contents do not match their hash (edited)` };
    prev = e.hash;
  }
  return { ok: true, head: prev, count: entries.length };
}

export function validateEntry(input) {
  const errors = [];
  if (!LEDGER_TYPES.includes(input.type)) errors.push(`type must be one of ${LEDGER_TYPES.join(', ')}`);
  if (input.type !== 'correction') {
    if (!Number.isInteger(input.amountPence) || input.amountPence <= 0) errors.push('amountPence must be a positive whole number of pence');
  }
  if (input.type === 'correction' && !Number.isInteger(input.supersedes)) errors.push('a correction must name the seq it supersedes');
  if (input.type === 'revenue' && input.settled && !input.evidence) errors.push('settled revenue needs evidence (a payment, payout or bank reference)');
  if (input.counterparty && !/^[A-Z]{2,8}-\d{1,6}$/.test(input.counterparty)) errors.push('counterparty must be a pseudonym such as CUST-001');
  for (const field of ['description', 'evidence', 'category', 'counterparty']) {
    if (looksPersonal(input[field])) errors.push(`${field} looks like it holds an email address or phone number; use a pseudonym`);
  }
  return errors;
}

export function addEntry(path, input, now = new Date()) {
  const errors = validateEntry(input);
  if (errors.length) throw new Error(errors.join('; '));
  const entries = readJsonl(path);
  const chain = verifyChain(entries);
  if (!chain.ok) throw new Error(`Ledger is damaged, nothing added: ${chain.error}`);
  const entry = {
    seq: entries.length + 1,
    at: now.toISOString(),
    type: input.type,
    amountPence: input.type === 'correction' ? 0 : input.amountPence,
    currency: 'GBP',
    settled: Boolean(input.settled),
    evidence: input.evidence ?? null,
    counterparty: input.counterparty ?? null,
    category: input.category ?? null,
    description: input.description ?? null,
    relatedParty: Boolean(input.relatedParty),
    attributable: input.attributable !== false,
    test: Boolean(input.test),
    fundedFromCapital: Boolean(input.fundedFromCapital),
    supersedes: input.supersedes ?? null,
    prevHash: chain.head,
  };
  entry.hash = sha256(canonical(entry));
  appendJsonl(path, entry);
  return entry;
}

export function summarise(entries, { capitalPence, targetNetPence }) {
  const superseded = new Set(entries.filter((e) => e.type === 'correction').map((e) => e.supersedes));
  const live = entries.filter((e) => e.type !== 'correction' && !superseded.has(e.seq));
  let counted = 0;
  let pendingRevenue = 0;
  const excluded = [];
  let refunds = 0;
  let expenses = 0;
  let capitalSpent = 0;
  for (const e of live) {
    if (e.type === 'revenue') {
      const reasons = [];
      if (!e.settled) reasons.push('not settled');
      if (!e.evidence) reasons.push('no evidence');
      if (e.relatedParty) reasons.push('related party');
      if (!e.attributable) reasons.push('not attributable to the mission');
      if (e.test) reasons.push('test transaction');
      if (reasons.length === 0) counted += e.amountPence;
      else {
        if (!e.settled && !e.test) pendingRevenue += e.amountPence;
        excluded.push({ seq: e.seq, amountPence: e.amountPence, reasons });
      }
    } else if (e.type === 'refund' && !e.test) {
      refunds += e.amountPence;
    } else if (e.type === 'expense' && !e.test && e.attributable) {
      expenses += e.amountPence; // settled or pending: both are owed
      if (e.fundedFromCapital) capitalSpent += e.amountPence;
    }
  }
  const net = counted - refunds - expenses;
  return {
    countedRevenuePence: counted,
    pendingRevenuePence: pendingRevenue,
    refundsPence: refunds,
    expensesPence: expenses,
    netPence: net,
    targetNetPence,
    progressPct: targetNetPence > 0 ? Math.max(0, Math.min(100, Math.round((net / targetNetPence) * 1000) / 10)) : 0,
    capitalPence,
    capitalSpentPence: capitalSpent,
    capitalRemainingPence: capitalPence - capitalSpent,
    entries: entries.length,
    excluded,
  };
}
