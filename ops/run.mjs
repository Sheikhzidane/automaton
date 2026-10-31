#!/usr/bin/env node
// Growth operations runner. Deterministic, no model calls, no money.
//
//   node ops/run.mjs init    --state DIR
//   node ops/run.mjs cycle   --state DIR [--only TASK_ID]
//   node ops/run.mjs status  --state DIR
//   node ops/run.mjs pause   --state DIR --reason "why"
//   node ops/run.mjs resume  --state DIR
//   node ops/run.mjs ledger  add|verify|summary --state DIR [...]
//   node ops/run.mjs verify-controls

import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initState, loadState, saveState, paths } from './lib/state.mjs';
import { runCycle, buildStatus } from './lib/engine.mjs';
import { addEntry, verifyChain, summarise } from './lib/ledger.mjs';
import { readJsonl } from './lib/util.mjs';
import { denyReason } from './lib/budget.mjs';
import { makeHttp } from './lib/http.mjs';
import { isDue, finishTask, slotKey, recoverStale } from './lib/queue.mjs';
import { acquireLock } from './lib/state.mjs';

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function need(a, key) {
  if (!a[key] || a[key] === true) {
    console.error(`--${key} is required`);
    process.exit(2);
  }
  return a[key];
}

async function verifyControls() {
  const dir = mkdtempSync(join(tmpdir(), 'growth-ops-verify-'));
  const now = new Date('2026-11-02T09:00:00Z');
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });
  const offline = async () => {
    throw new Error('network disabled in verify-controls');
  };

  // 1. Kill switch
  let s = initState(dir);
  s.control = { paused: true, reason: 'verify' };
  saveState(s);
  let r = await runCycle({ dir, now: () => now, env: {}, fetchImpl: offline, log: () => {} });
  check('Paused engine runs no tasks', r.results.length === 0);
  s = loadState(dir);
  s.control = { paused: false, reason: null };
  saveState(s);

  // 2-3. Spending needs an approval and must fit in the capital left
  const costly = { id: 'x', priority: 2, costPence: 500 };
  const budget = { compute: null };
  const summary = { capitalRemainingPence: 2000 };
  check('Task with a cost and no approval is refused', denyReason({ task: costly, budget, ledgerSummary: summary, approvals: [], control: {}, now }) !== null);
  const approved = [{ taskId: 'x', status: 'approved', amountPence: 500, expiresAt: '2026-12-01T00:00:00Z' }];
  check('Approved task within capital is allowed', denyReason({ task: costly, budget, ledgerSummary: summary, approvals: approved, control: {}, now }) === null);
  check('Spend above remaining capital is refused even when approved', denyReason({ task: { ...costly, costPence: 2500 }, budget, ledgerSummary: summary, approvals: [{ ...approved[0], amountPence: 2500 }], control: {}, now }) !== null);
  check('Expired approval is refused', denyReason({ task: costly, budget, ledgerSummary: summary, approvals: [{ ...approved[0], expiresAt: '2026-11-01T00:00:00Z' }], control: {}, now }) !== null);

  // 4. Compute cap
  const capped = { compute: { month: '2026-11', secondsUsed: 60 * 901, capMinutes: 900 } };
  check('Past the compute cap, low-priority tasks stop', denyReason({ task: { priority: 3, costPence: 0 }, budget: capped, control: {}, now }) !== null);
  check('Past the compute cap, priority-1 health checks still run', denyReason({ task: { priority: 1, costPence: 0 }, budget: capped, control: {}, now }) === null);

  // 5-7. Ledger integrity and rules
  const ledger = paths(dir).ledger;
  addEntry(ledger, { type: 'revenue', amountPence: 60000, settled: true, evidence: 'pi_test', counterparty: 'CUST-001', test: true }, now);
  addEntry(ledger, { type: 'revenue', amountPence: 60000, settled: false, counterparty: 'CUST-002' }, now);
  addEntry(ledger, { type: 'revenue', amountPence: 60000, settled: true, evidence: 'po_x', counterparty: 'CUST-003', relatedParty: true }, now);
  const sm = summarise(readJsonl(ledger), { capitalPence: 2000, targetNetPence: 200000 });
  check('Test, unsettled and related-party revenue are not counted', sm.countedRevenuePence === 0, `counted ${sm.countedRevenuePence}`);
  let refused = false;
  try {
    addEntry(ledger, { type: 'revenue', amountPence: 100, settled: true, evidence: 'x', counterparty: 'jo@example.com' }, now);
  } catch {
    refused = true;
  }
  check('Ledger refuses an email address as a counterparty', refused);
  const text = readFileSync(ledger, 'utf8').replace('"amountPence":60000', '"amountPence":6000000');
  writeFileSync(ledger, text);
  check('An edited ledger line is detected', !verifyChain(readJsonl(ledger)).ok);

  // 8. Outbound requests only to allowed hosts over HTTPS
  const http = makeHttp({ allowHosts: ['opslog.co.uk'], fetchImpl: offline });
  let blockedHost = false;
  let blockedHttp = false;
  try {
    await http('https://example.com/');
  } catch (e) {
    blockedHost = /not an allowed host/.test(e.message);
  }
  try {
    await http('http://opslog.co.uk/');
  } catch (e) {
    blockedHttp = /not an allowed host/.test(e.message);
  }
  check('Requests to hosts outside the allowlist are refused', blockedHost);
  check('Plain HTTP is refused', blockedHttp);

  // 9. Idempotency and crash recovery
  const t = { id: 'demo', intervalMinutes: 1440, maxAttempts: 2, history: [] };
  finishTask(t, { outcome: 'succeeded' }, now, 1);
  check('A task that succeeded in this slot is not run again', !isDue(t, now) && t.lastIdempotencyKey === slotKey(t, now));
  const crashed = [{ id: 'c', status: 'running', lease: { runId: 'old', at: now.toISOString() }, history: [] }];
  check('A task left running by a crashed cycle is recovered', recoverStale(crashed, now, 'new').length === 1 && crashed[0].status === 'retrying');

  // 10. Single runner at a time
  s = loadState(dir);
  const first = acquireLock(s, 'a', now);
  const second = acquireLock(s, 'b', now);
  check('A second cycle cannot start while one holds the lock', first.ok && !second.ok);

  let failed = 0;
  for (const res of results) {
    console.log(`${res.ok ? 'PASS' : 'FAIL'}  ${res.name}${res.detail && !res.ok ? ` (${res.detail})` : ''}`);
    if (!res.ok) failed++;
  }
  console.log(failed ? `${failed} control(s) failed.` : `All ${results.length} controls passed.`);
  return failed ? 1 : 0;
}

async function main() {
  const a = args(process.argv.slice(2));
  const cmd = a._[0];
  if (cmd === 'verify-controls') process.exit(await verifyControls());
  if (cmd === 'init') {
    initState(need(a, 'state'));
    console.log('Initialised.');
    return;
  }
  const dir = need(a, 'state');
  if (cmd === 'cycle') {
    const r = await runCycle({ dir, only: typeof a.only === 'string' ? a.only : null });
    if (r.locked) process.exit(0);
    process.exit(r.ok ? 0 : 1);
  }
  if (cmd === 'status') {
    const s = loadState(dir);
    const st = buildStatus(s, { now: new Date(), cycle: { runId: null, startedAt: s.memory.lastCycleAt ?? null } });
    for (const t of st.tasks) console.log(`${t.status.padEnd(9)} ${t.id.padEnd(24)} last ${t.lastRunAt ?? 'never'}  next ${t.nextRunAt ?? 'next cycle'}  ${t.lastNote ?? ''}`);
    console.log(`Paused: ${st.paused}. Next scheduled cycle: ${st.runtime.nextScheduledAt}. Capital left: ${st.budget.capitalRemainingPence}p.`);
    return;
  }
  if (cmd === 'pause' || cmd === 'resume') {
    const s = loadState(dir);
    s.control = cmd === 'pause' ? { paused: true, reason: typeof a.reason === 'string' ? a.reason : null, at: new Date().toISOString() } : { paused: false, reason: null, at: new Date().toISOString() };
    saveState(s);
    console.log(cmd === 'pause' ? 'Paused.' : 'Resumed.');
    return;
  }
  if (cmd === 'ledger') {
    const s = loadState(dir);
    const sub = a._[1];
    if (sub === 'verify') {
      const v = verifyChain(readJsonl(s.files.ledger));
      console.log(v.ok ? `Ledger intact: ${v.count} lines.` : `Ledger damaged: ${v.error}`);
      process.exit(v.ok ? 0 : 1);
    }
    if (sub === 'summary') {
      console.log(JSON.stringify(summarise(readJsonl(s.files.ledger), s.config.mission), null, 2));
      return;
    }
    if (sub === 'add') {
      const e = addEntry(s.files.ledger, {
        type: need(a, 'type'),
        amountPence: a['amount-pence'] ? Number(a['amount-pence']) : undefined,
        settled: !a.pending,
        evidence: typeof a.evidence === 'string' ? a.evidence : null,
        counterparty: typeof a.counterparty === 'string' ? a.counterparty : null,
        category: typeof a.category === 'string' ? a.category : null,
        description: typeof a.description === 'string' ? a.description : null,
        relatedParty: Boolean(a['related-party']),
        attributable: !a['not-attributable'],
        test: Boolean(a.test),
        fundedFromCapital: Boolean(a['from-capital']),
        supersedes: a.supersedes ? Number(a.supersedes) : undefined,
      });
      console.log(`Recorded line ${e.seq}.`);
      return;
    }
  }
  console.error('Unknown command. See the header of ops/run.mjs.');
  process.exit(2);
}

main().catch((err) => {
  console.error(err?.stack ?? String(err));
  process.exit(3);
});
