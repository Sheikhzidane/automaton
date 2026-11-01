// The mission ledger: every pound in and out, append-only and
// hash-chained, with the last verified head kept in engine state so a
// line edited, removed, or cut off the end is detected on the next run.
//
// Only genuine mission earnings count towards the target: settled, with
// a payment reference as evidence, not from a related party (your own
// businesses, employer, family), not a test, attributable to mission
// activity, and not a duplicate of a payment already recorded.
// Corrections never edit a line; they add one that supersedes it.

import { appendJsonl, readJsonl, sha256, looksPersonal, looksEmail } from './util.mjs';

export const LEDGER_TYPES = ['revenue', 'refund', 'expense', 'correction'];
const GENESIS = '0'.repeat(64);

// Payment, charge, payout, transfer or bank references. An invoice
// number is not evidence that money arrived. A bank reference has no
// spaces and must carry at least four digits (a date, an amount or the
// bank's own reference), so a payer's name alone cannot pass as one.
export const PAYMENT_EVIDENCE = /^((pi|ch|py|po|tr|txn)_[A-Za-z0-9]{3,}|bank:(?=(?:[^0-9]*[0-9]){4})[A-Za-z0-9._\/-]{4,40})$/;
const EVIDENCE_MAX = 80;

// A ledger line can never be erased, so it must hold nothing about a
// person. Counterparties are pseudonyms; the mapping from pseudonym to
// customer is kept outside the ledger, and deleting it is the erasure.
const DESCRIPTION_MAX = 120;
const CATEGORY = /^[a-z0-9._-]{1,40}$/;

function canonical(entry) {
  const { hash, ...rest } = entry;
  const keys = Object.keys(rest).sort();
  return JSON.stringify(keys.map((k) => [k, rest[k]]));
}

export function verifyChain(entries, knownHead = null) {
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq !== i + 1) return { ok: false, error: `Line ${i + 1}: sequence ${e.seq}, expected ${i + 1}` };
    if (e.prevHash !== prev) return { ok: false, error: `Line ${i + 1}: previous hash does not match (a line was removed, added or changed above it)` };
    if (sha256(canonical(e)) !== e.hash) return { ok: false, error: `Line ${i + 1}: contents do not match their hash (edited)` };
    prev = e.hash;
  }
  if (knownHead && knownHead.count > 0) {
    if (entries.length < knownHead.count) {
      return { ok: false, error: `The ledger had ${knownHead.count} lines at the last check and now has ${entries.length} (lines removed from the end)` };
    }
    if (entries[knownHead.count - 1].hash !== knownHead.head) {
      return { ok: false, error: `Line ${knownHead.count} no longer matches the last verified ledger` };
    }
  }
  return { ok: true, head: prev, count: entries.length };
}

// Which lines are in force. A correction only targets earlier lines, so
// walking backwards decides every correction before the lines it names;
// superseding a correction restores what it had cancelled.
export function effectiveSeqs(entries) {
  const cancelled = new Set();
  const live = new Set();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (cancelled.has(e.seq)) continue;
    live.add(e.seq);
    if (e.type === 'correction') cancelled.add(e.supersedes);
  }
  return live;
}

export function validateEntry(input, entries = []) {
  const errors = [];
  if (!LEDGER_TYPES.includes(input.type)) errors.push(`type must be one of ${LEDGER_TYPES.join(', ')}`);
  if (input.type !== 'correction') {
    if (!Number.isInteger(input.amountPence) || input.amountPence <= 0) errors.push('amountPence must be a positive whole number of pence');
  }
  if (input.type === 'correction') {
    const target = entries.find((e) => e.seq === input.supersedes);
    if (!Number.isInteger(input.supersedes) || !target) errors.push('a correction must name an existing earlier line (supersedes)');
  }
  if (input.type === 'revenue' && input.settled) {
    if (!input.evidence) errors.push('settled revenue needs evidence: a payment, payout or bank reference');
    else if (!input.test && !PAYMENT_EVIDENCE.test(input.evidence)) errors.push('evidence for settled revenue must be a payment reference (pi_, ch_, py_, po_, tr_, txn_) or bank:<reference>; an invoice number does not show money arrived');
  }
  if (input.type === 'revenue' && input.evidence) {
    const live = effectiveSeqs(entries);
    if (entries.some((e) => e.type === 'revenue' && live.has(e.seq) && e.evidence === input.evidence)) {
      errors.push(`a payment with evidence ${input.evidence} is already recorded`);
    }
  }
  if (input.counterparty && !/^[A-Z]{2,8}-\d{1,6}$/.test(input.counterparty)) errors.push('counterparty must be a pseudonym such as CUST-001');
  if (input.category && !CATEGORY.test(input.category)) errors.push('category must be a short code such as licence or setup (lower case, no spaces)');
  if (input.description && String(input.description).length > DESCRIPTION_MAX) {
    errors.push(`description must be ${DESCRIPTION_MAX} characters or fewer, and must not name a person`);
  }
  for (const field of ['description', 'category', 'counterparty']) {
    if (looksPersonal(input[field])) errors.push(`${field} looks like it holds an email address or phone number; use a pseudonym`);
  }
  // A payment reference is often a long run of digits (txn_1234567890,
  // bank:20261031-60000) that a phone test could mistake for a number, so
  // a well-formed reference is checked for an email only. Any other
  // evidence, on any type of line, gets the full personal-data test.
  if (input.evidence !== undefined && input.evidence !== null) {
    const ev = String(input.evidence);
    if (ev.length > EVIDENCE_MAX) errors.push(`evidence must be ${EVIDENCE_MAX} characters or fewer`);
    if (PAYMENT_EVIDENCE.test(ev) ? looksEmail(ev) : looksPersonal(ev)) {
      errors.push('evidence looks like it holds an email address or phone number; use the payment or receipt reference');
    }
  }
  return errors;
}

export function addEntry(path, input, now = new Date()) {
  const entries = readJsonl(path);
  const chain = verifyChain(entries);
  if (!chain.ok) throw new Error(`Ledger is damaged, nothing added: ${chain.error}`);
  const errors = validateEntry(input, entries);
  if (errors.length) throw new Error(errors.join('; '));
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
  const live = effectiveSeqs(entries);
  const rows = entries.filter((e) => e.type !== 'correction' && live.has(e.seq));
  let counted = 0;
  let pendingRevenue = 0;
  const excluded = [];
  let refunds = 0;
  let expenses = 0;
  let capitalSpent = 0;
  const seenEvidence = new Set();
  const customers = new Set();
  for (const e of rows) {
    if (e.type === 'revenue') {
      const reasons = [];
      if (!e.settled) reasons.push('not settled');
      if (!e.evidence) reasons.push('no evidence');
      if (e.relatedParty) reasons.push('related party');
      if (!e.attributable) reasons.push('not attributable to the mission');
      if (e.test) reasons.push('test transaction');
      if (e.evidence && seenEvidence.has(e.evidence)) reasons.push('duplicate evidence');
      if (e.evidence) seenEvidence.add(e.evidence);
      if (reasons.length === 0) {
        counted += e.amountPence;
        if (e.counterparty) customers.add(e.counterparty);
      } else {
        if (!e.settled && !e.test && !e.relatedParty) pendingRevenue += e.amountPence;
        excluded.push({ seq: e.seq, amountPence: e.amountPence, reasons });
      }
    } else if (e.type === 'refund' && !e.test) {
      refunds += e.amountPence;
    } else if (e.type === 'expense' && !e.test) {
      if (e.attributable) expenses += e.amountPence; // settled or pending: both are owed
      if (e.fundedFromCapital) capitalSpent += e.amountPence; // capital is spent whatever it was for
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
    payingCustomers: customers.size,
    entries: entries.length,
    excluded,
  };
}

// For the engine: a summary that never throws. A damaged or unreadable
// ledger gives no capital, so nothing that costs money can run.
export function safeSummary(path, mission) {
  try {
    return { summary: summarise(readJsonl(path), mission), error: null };
  } catch (err) {
    return {
      summary: { ...summarise([], mission), capitalRemainingPence: 0, unreadable: true },
      error: err.message,
    };
  }
}
